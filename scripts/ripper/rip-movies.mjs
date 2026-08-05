#!/usr/bin/env node
/**
 * Movie path for the ripper. The main pipeline (ripper.mjs) is box-set shaped:
 * it splits play-alls, expects an episode count, and stages into a show folder.
 * A feature disc has exactly one output, so it gets its own thin command rather
 * than an --is-movie flag threaded through the episode classifier.
 *
 * Keeps the v3 rules that were paid for in real failures:
 *   - refuse-by-default: an ambiguous main title stops the disc, never guesses
 *   - every in-progress step carries a deadline (stall watchdog kills the child)
 *   - a bad disc degrades ITS drive only; the other drive keeps going
 *   - verify against content (ffprobe duration), not against our own filename
 *
 *   node rip-movies.mjs plan            # scan both drives, print the decision, write nothing
 *   node rip-movies.mjs rip --apply     # rip -> staging -> verify -> library -> eject
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import {
  MAKEMKVCON,
  enumerateDrives,
  scanDisc,
  eject,
} from './lib/makemkv.mjs';
import { parseRobotLine } from './lib/robot.mjs';
import { MEDIA_ROOT } from './config.mjs';

/**
 * Words too common across a franchise to identify a disc on their own — a label
 * reading "TROLLS" cannot pick between three Trolls films.
 */
const FRANCHISE_STOPWORDS = new Set(['THE', 'A', 'AN', 'OF', 'AND', 'PART', 'TROLLS']);

/**
 * `--movie "Trolls (2016)" --runtime 92` replaces the built-in list for a run,
 * so ripping a disc nobody has ripped before needs no code edit.
 */
export function parseMovieFlag(argv) {
  const read = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const spec = read('movie');
  if (!spec) return null;

  const match = /^(.*?)\s*\((\d{4})\)\s*$/.exec(spec);
  if (!match) throw new Error(`--movie must look like "Title (Year)", got: ${spec}`);
  const [, title, year] = match;
  const runtime = read('runtime');
  if (runtime !== undefined && !(Number(runtime) > 0)) {
    throw new Error(`--runtime must be a positive number of minutes, got: ${runtime}`);
  }
  const hints = title.toUpperCase().split(/[^A-Z0-9]+/)
    .filter((w) => w.length > 1 && !FRANCHISE_STOPWORDS.has(w));
  return {
    title: title.trim(),
    year: Number(year),
    // Without a runtime the duration check cannot run; the feature-length bounds
    // in pickMainTitle still apply, and the ripped duration is reported.
    runtimeMin: runtime === undefined ? null : Number(runtime),
    hints,
  };
}

/** Default expectations; --movie overrides them for a single-disc run. */
const EXPECTED = [
  {
    title: 'Trolls World Tour',
    year: 2020,
    runtimeMin: 91,
    // 'TROLLS' is shared by both discs, so it carries no signal — only the
    // distinguishing words vote.
    hints: ['WORLD', 'TOUR'],
  },
  {
    title: 'Trolls Band Together',
    year: 2023,
    runtimeMin: 92,
    hints: ['BAND', 'TOGETHER'],
  },
];

const STAGING_MOVIES = path.join(MEDIA_ROOT, '_staging', 'movies');
const LIBRARY_MOVIES = path.join(MEDIA_ROOT, 'library', 'movies');

const LIMITS = {
  mediaWaitMs: 10 * 60_000, // how long we wait for trays to close + spin up
  discPollMs: 5_000,
  ripStallMs: 12 * 60_000, // no progress for this long => kill, drive to attention
  finalizeStallMs: 30 * 60_000, // looser budget once progress has reached the tail
  ripTotalMs: 120 * 60_000,
  featureMinS: 60 * 60,
  featureMaxS: 200 * 60,
  // A runner-up this close to the longest title means we cannot tell which is
  // the feature; below it, the longest wins outright.
  ambiguousRatio: 0.9,
  duplicateS: 5, // same-length titles are angles/playlists of one feature
  durationTolerance: 0.12, // ffprobe vs published runtime
};

const log = (...parts) => console.log(...parts);
const fmtDuration = (s) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function folderName(movie) {
  return `${movie.title} (${movie.year})`;
}

/** Wait until both trays report media, or return whatever showed up in time. */
async function waitForDiscs({ want = 2 } = {}) {
  const deadline = Date.now() + LIMITS.mediaWaitMs;
  let announced = 0;
  for (;;) {
    const drives = await enumerateDrives();
    const loaded = drives.filter((d) => d.mediaPresent);
    if (loaded.length > announced) {
      for (const drive of loaded.slice(announced)) {
        log(`  disc detected in drive ${drive.index}: ${drive.discLabel || '(no label)'}`);
      }
      announced = loaded.length;
    }
    if (loaded.length >= want) return loaded;
    if (Date.now() > deadline) {
      if (loaded.length) {
        log(`  timed out waiting for ${want} discs; continuing with ${loaded.length}`);
        return loaded;
      }
      throw new Error('No disc detected in either drive before the deadline.');
    }
    await new Promise((r) => setTimeout(r, LIMITS.discPollMs));
  }
}

/**
 * Pick the feature. Longest title wins, but only when nothing else is close
 * enough to be mistaken for it — otherwise we stop and print the table.
 */
function pickMainTitle(titles) {
  const sorted = [...titles].sort((a, b) => b.duration_s - a.duration_s);
  const main = sorted[0];
  if (!main) return { error: 'disc exposed no titles' };
  if (main.duration_s < LIMITS.featureMinS) {
    return { error: `longest title is ${fmtDuration(main.duration_s)}, too short for a feature` };
  }
  if (main.duration_s > LIMITS.featureMaxS) {
    return { error: `longest title is ${fmtDuration(main.duration_s)}, too long for a feature (looped/play-all?)` };
  }

  const rival = sorted[1];
  if (rival) {
    const gap = main.duration_s - rival.duration_s;
    const isDuplicate = gap <= LIMITS.duplicateS;
    if (!isDuplicate && rival.duration_s >= main.duration_s * LIMITS.ambiguousRatio) {
      return {
        error:
          `two plausible features: title ${main.id} (${fmtDuration(main.duration_s)}) vs ` +
          `title ${rival.id} (${fmtDuration(rival.duration_s)})`,
      };
    }
    if (isDuplicate) {
      // Angles of the same feature: take the one with the most chapters, which
      // is the one with usable seek points.
      const dupes = sorted.filter((t) => main.duration_s - t.duration_s <= LIMITS.duplicateS);
      const best = dupes.sort((a, b) => (b.chapters || 0) - (a.chapters || 0))[0];
      return { title: best, duplicates: dupes.length - 1 };
    }
  }
  return { title: main, duplicates: 0 };
}

/** Match a disc label to one of the expected movies; refuse when unsure. */
function matchMovie(discLabel, taken, expected = EXPECTED) {
  const label = String(discLabel || '').toUpperCase();
  const scored = expected.map((movie) => ({
    movie,
    score: movie.hints.filter((hint) => label.includes(hint)).length,
  })).sort((a, b) => b.score - a.score);

  if (scored[0] && scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? -1)) {
    return { movie: scored[0].movie };
  }
  // Label was unhelpful (many DVDs ship a generic one). If only one expected
  // movie is still unclaimed, that is the answer by elimination.
  const remaining = expected.filter((m) => !taken.has(folderName(m)));
  if (remaining.length === 1) {
    return { movie: remaining[0], byElimination: true };
  }
  return { error: `cannot tell which movie this is from label "${discLabel || '(none)'}"` };
}

/** The total-phase during which bytes actually reach the disk. */
const SAVING_PHASE = /saving/i;

/**
 * MakeMKV's PRGV counter restarts at every new total-phase (PRGT), so a raw
 * percentage latches at 100 during the first trivial phase ("Scanning CD-ROM
 * devices") and never drops again. Reading it as whole-job progress silently
 * granted the loose finalize stall budget for an entire rip.
 */
export function createProgressTracker() {
  let phase = '';
  let percent = 0;
  // Tracked apart from `percent`: folding them together lets quiet sub-milestone
  // updates drag the reporting threshold along, so milestones never fire.
  let lastReported = 0;
  return {
    get phase() { return phase; },
    get percent() { return percent; },
    /** True only in the write phase's tail, where MakeMKV legitimately goes quiet. */
    get finalizing() { return SAVING_PHASE.test(phase) && percent >= 99; },
    /** @returns {number|null} a percent worth logging, else null. */
    accept(record) {
      if (record.type === 'PRGT') {
        const name = record.fields[2] || '';
        if (name !== phase) {
          phase = name;
          percent = 0;
          lastReported = 0;
        }
        return null;
      }
      if (record.type !== 'PRGV') return null;
      const total = Number(record.fields[1]);
      const max = Number(record.fields[2]);
      if (!max || !Number.isFinite(total)) return null;
      const next = Math.min(100, Math.floor((total / max) * 100));
      if (next > percent) percent = next;
      // Report forward movement only, in 10-point steps.
      if (next < lastReported + 10) return null;
      lastReported = next;
      return next;
    },
  };
}

/** makemkvcon rip with a stall watchdog — the v2 hang blocked every drive. */
function ripTitle({ index, titleId, destDir, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      MAKEMKVCON,
      ['-r', '--progress=-same', 'mkv', `disc:${index}`, String(titleId), destDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // MakeMKV can exit 0 having written nothing, so the raw stream is the only
    // record of why. Keep all of it on disk rather than a rolling tail.
    const logPath = path.join(destDir, 'makemkv.log');
    const logFile = createWriteStream(logPath, { flags: 'a' });
    const messages = [];
    let pending = '';
    let lastProgress = Date.now();
    const progress = createProgressTracker();
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(hardStop);
      logFile.end();
      fn(arg);
    };

    const watchdog = setInterval(() => {
      // MakeMKV goes quiet at the tail while it flushes and finalizes the file,
      // and on a contended USB bus that silence can outlast a normal stall
      // budget — so the last stretch gets a longer (still bounded) leash.
      const budget = progress.finalizing ? LIMITS.finalizeStallMs : LIMITS.ripStallMs;
      if (Date.now() - lastProgress > budget) {
        child.kill('SIGKILL');
        finish(reject, new Error(
          `${label}: no progress for ${Math.round(budget / 60000)} min ` +
          `during "${progress.phase}" at ${progress.percent}% — killed` +
          (messages.length ? `; last from makemkv: ${messages.slice(-3).join(' | ')}` : ''),
        ));
      }
    }, 30_000);
    const hardStop = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${label}: exceeded ${LIMITS.ripTotalMs / 60000} min — killed`));
    }, LIMITS.ripTotalMs);

    const consume = (chunk) => {
      logFile.write(chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const record = parseRobotLine(line);
        if (record?.type === 'PRGV') lastProgress = Date.now();
        if (record) {
          const milestone = progress.accept(record);
          if (milestone !== null) log(`  ${label}: ${progress.phase} ${milestone}%`);
        }
        if (record?.type === 'MSG') {
          messages.push(record.fields[3] || record.fields.join(','));
          if (messages.length > 20) messages.shift();
        }
      }
    };

    child.stdout.setEncoding('utf8').on('data', consume);
    child.stderr.setEncoding('utf8').on('data', consume);
    child.on('error', (err) => finish(reject, err));
    child.on('close', async (code) => {
      if (code !== 0) {
        return finish(reject, new Error(`${label}: makemkvcon exited ${code}: ${messages.join(' | ')}`));
      }
      try {
        const mkvs = (await readdir(destDir)).filter((n) => n.toLowerCase().endsWith('.mkv'));
        if (mkvs.length !== 1) {
          // A clean exit with no file means makemkv gave up quietly — its own
          // messages are the only explanation, so they must reach the caller.
          throw new Error(
            `${label}: makemkvcon exited 0 but left ${mkvs.length} mkv files` +
            (messages.length ? `; last from makemkv: ${messages.slice(-5).join(' | ')}` : '') +
            `; full log: ${logPath}`,
          );
        }
        finish(resolve, path.join(destDir, mkvs[0]));
      } catch (err) {
        finish(reject, err);
      }
    });
  });
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      const seconds = Number.parseFloat(out.trim());
      if (code !== 0 || !Number.isFinite(seconds)) {
        return reject(new Error(`ffprobe could not read a duration from ${path.basename(file)}`));
      }
      resolve(seconds);
    });
  });
}

/** Survey both drives without touching anything. */
async function buildPlan({ want = 2, expected = EXPECTED } = {}) {
  const loaded = await waitForDiscs({ want });
  const taken = new Set();
  const plan = [];

  for (const drive of loaded) {
    const entry = { drive };
    try {
      const { discLabel, titles } = await scanDisc(drive.index);
      entry.discLabel = discLabel || drive.discLabel;
      entry.titles = titles;

      const picked = pickMainTitle(titles);
      if (picked.error) throw new Error(picked.error);
      entry.mainTitle = picked.title;
      entry.duplicates = picked.duplicates;

      const matched = matchMovie(entry.discLabel, taken, expected);
      if (matched.error) throw new Error(matched.error);
      entry.movie = matched.movie;
      entry.byElimination = Boolean(matched.byElimination);
      taken.add(folderName(matched.movie));
    } catch (err) {
      entry.error = err.message;
    }
    plan.push(entry);
  }
  return plan;
}

function printPlan(plan) {
  for (const entry of plan) {
    log(`\ndrive ${entry.drive.index} — label: ${entry.discLabel || entry.drive.discLabel || '(none)'}`);
    for (const title of (entry.titles || []).slice().sort((a, b) => b.duration_s - a.duration_s).slice(0, 8)) {
      const mark = title.id === entry.mainTitle?.id ? ' <= FEATURE' : '';
      log(`    title ${String(title.id).padStart(2)}  ${fmtDuration(title.duration_s)}  ${String(title.chapters ?? '?').padStart(3)} ch${mark}`);
    }
    if ((entry.titles || []).length > 8) log(`    ... ${entry.titles.length - 8} more titles`);
    if (entry.error) {
      log(`    REFUSED: ${entry.error}`);
      continue;
    }
    log(`    -> ${folderName(entry.movie)}${entry.byElimination ? ' (matched by elimination — disc label gave nothing)' : ''}`);
    if (entry.duplicates) log(`    (${entry.duplicates} duplicate playlist(s) of the feature ignored)`);
    log(`    -> ${path.join(LIBRARY_MOVIES, folderName(entry.movie), `${folderName(entry.movie)}.mkv`)}`);
  }
}

/** Rip one disc end to end. Throws only for this drive. */
async function ripOne(entry) {
  const name = folderName(entry.movie);
  const stageDir = path.join(STAGING_MOVIES, name);
  await mkdir(stageDir, { recursive: true });

  const existing = (await readdir(stageDir)).filter((n) => n.toLowerCase().endsWith('.mkv'));
  if (existing.length) throw new Error(`${name}: staging already holds ${existing.join(', ')} — clear it first`);

  log(`  ${name}: ripping title ${entry.mainTitle.id} (${fmtDuration(entry.mainTitle.duration_s)}) from drive ${entry.drive.index}`);
  const staged = await ripTitle({
    index: entry.drive.index,
    titleId: entry.mainTitle.id,
    destDir: stageDir,
    label: name,
  });

  // Verify against the content, not against the name we chose.
  const actual = await ffprobeDuration(staged);
  const bytes = (await stat(staged)).size;
  if (entry.movie.runtimeMin) {
    const expected = entry.movie.runtimeMin * 60;
    const drift = Math.abs(actual - expected) / expected;
    if (drift > LIMITS.durationTolerance) {
      throw new Error(
        `${name}: ripped ${fmtDuration(actual)} but ${entry.movie.title} runs ~${entry.movie.runtimeMin}m ` +
        `(${Math.round(drift * 100)}% off) — left in staging for review`,
      );
    }
    log(`  ${name}: verified ${fmtDuration(actual)}, ${(bytes / 1e9).toFixed(2)} GB`);
  } else {
    // No published runtime given, so this is unverified rather than verified.
    log(`  ${name}: ripped ${fmtDuration(actual)}, ${(bytes / 1e9).toFixed(2)} GB (no --runtime to check against)`);
  }

  const destDir = path.join(LIBRARY_MOVIES, name);
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${name}.mkv`);
  try {
    await stat(dest);
    throw new Error(`${name}: ${dest} already exists — not overwriting`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await rename(staged, dest);
  log(`  ${name}: -> ${dest}`);

  await eject(entry.drive.osDevice);
  log(`  ${name}: ejected drive ${entry.drive.index}`);
  return dest;
}

async function main() {
  const [cmd = 'plan'] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  const discsFlag = process.argv.find((a) => a.startsWith('--discs='));
  const want = discsFlag ? Number(discsFlag.split('=')[1]) : 2;
  if (!Number.isInteger(want) || want < 1) throw new Error('--discs= must be a positive integer');
  const override = parseMovieFlag(process.argv);
  const expected = override ? [override] : EXPECTED;
  if (override) {
    log(`expecting one disc: ${folderName(override)}` +
        (override.runtimeMin ? ` (~${override.runtimeMin}m)` : ' (no runtime check)'));
  }

  log(`waiting for ${want} disc(s) (close the trays)...`);
  const plan = await buildPlan({ want, expected });
  printPlan(plan);

  const ready = plan.filter((e) => !e.error);
  const refused = plan.filter((e) => e.error);
  log(`\n${ready.length} disc(s) ready, ${refused.length} refused.`);

  if (cmd !== 'rip' || !apply) {
    log('\nplan only — nothing written. Re-run with: node rip-movies.mjs rip --apply');
    return;
  }
  if (!ready.length) throw new Error('nothing to rip');

  // Both drives run concurrently; one bad disc must not take the other down.
  const results = await Promise.allSettled(ready.map((entry) => ripOne(entry)));
  log('');
  results.forEach((result, i) => {
    const name = folderName(ready[i].movie);
    log(result.status === 'fulfilled' ? `DONE      ${name}` : `FAILED    ${name}: ${result.reason.message}`);
  });
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}

// Pure decision logic is exported so the tests can exercise it without a disc.
export { pickMainTitle, matchMovie, folderName, EXPECTED, LIMITS };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
