#!/usr/bin/env node
/**
 * TMNT (2012) 20-disc rip orchestrator.
 * Differs from ripper.mjs (2003 run): no camera/OCR — discs are identified by
 * the insert-sheet manifest (data/tmnt-2012-discs.mjs) + duration-shape match,
 * ripped to internal-SSD staging, finished episodes land in ready-to-copy/
 * where copy-watcher-2012.sh ships them to the Seagate and feeds voice-lab.
 *
 * Usage: node rip2012.mjs watch
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const LIB_ROOT = process.env.LOCAL_LIBRARY?.trim() || path.join(os.homedir(), 'Movies', 'library');
// Staging dirs are named disc-NN, so two orchestrators running different shows
// in parallel collide whenever their disc numbers coincide (two makemkvcon
// processes writing into one dir make each other's "exactly one new MKV" check
// fail). Give every parallel orchestrator its own staging root.
const STAGING = process.env.RIPPER_STAGING_DIR?.trim()
  || path.join(LIB_ROOT, 'staging', 'tmnt-2012');
const READY = path.join(LIB_ROOT, 'ready-to-copy');
process.env.RIPPER_STATE_DIR ||= path.join(LIB_ROOT, '.ripper-2012');

const { DISCS, SHOW_NAME, AVG_EP_S, episodeCount } =
  await import(process.env.RIPPER_MANIFEST ?? './data/tmnt-2012-discs.mjs');
const makemkv = await import('./lib/makemkv.mjs');
const { readChapters, groupChapters, splitAtChapters, verifyRip } = await import('./lib/split.mjs');
const { DiscThread, isLiveThread } = await import('./lib/discthread.mjs');
const { notify } = await import('./lib/slack.mjs');
const { acquireWatchLock, logEvent } = await import('./lib/state.mjs');

const POLL_MS = 15_000;
const MIN_EP_S = 18 * 60;
const DONE_PATH = path.join(process.env.RIPPER_STATE_DIR, 'discs-done.json');

// Concurrent `makemkvcon info` invocations (enumerate poll + per-drive scans)
// contend and return empty title lists — serialize them. Rips stay parallel.
let infoChain = Promise.resolve();
function withInfoLock(fn) {
  const next = infoChain.then(fn, fn);
  infoChain = next.catch(() => {});
  return next;
}

async function scanDiscSafe(index) {
  for (let attempt = 1; ; attempt += 1) {
    const scan = await withInfoLock(() => makemkv.scanDisc(index));
    if (scan.titles.length) return scan;
    if (attempt >= 3) return scan;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function loadDone() {
  try { return JSON.parse(await fsp.readFile(DONE_PATH, 'utf8')); } catch { return {}; }
}
async function saveDone(done) {
  await fsp.mkdir(path.dirname(DONE_PATH), { recursive: true });
  await fsp.writeFile(`${DONE_PATH}.tmp`, JSON.stringify(done, null, 2));
  await fsp.rename(`${DONE_PATH}.tmp`, DONE_PATH);
}

function safeTitle(title) {
  return String(title).replace(/[|"$:<>?*\\/]/g, '').replace(/\s+/g, ' ').trim();
}
function seasonDir(code) {
  return `Season ${code.slice(1, 3)}`;
}
function finalName(code, title) {
  return `${SHOW_NAME} ${code} - ${safeTitle(title)}.mkv`;
}
function tolerance(expected_s) {
  return Math.max(5 * 60, expected_s * 0.2);
}

const SHIPPED_SHOW_DIR = path.join(process.env.RIPPER_MEDIA_ROOT?.trim() || '/Volumes/Seagate 4TB/media', 'library', 'shows', SHOW_NAME);

/**
 * Volume labels repeat across the retail 2-disc sets (discs 13 AND 14 are both
 * TMNT_BEYOND_KNOWN_UNIVERSE), so a label matching a done disc doesn't prove a
 * reinsert. Ground truth is the done disc's shipped files: per-entry durations
 * (split parts summed back) must line up with the scanned titles.
 * Returns true (same disc), false (different disc), or null (shipped files
 * unavailable — caller must fail safe).
 */
async function isSameAsDoneDisc(discNumber, titles) {
  const def = DISCS.find((d) => d.disc === discNumber);
  if (!def) return null;
  const scanned = titles.filter((t) => t.duration_s >= MIN_EP_S);
  if (scanned.length !== def.entries.length) return false;
  for (let i = 0; i < def.entries.length; i += 1) {
    const entry = def.entries[i];
    let sum = 0;
    for (let j = 0; j < entry.codes.length; j += 1) {
      const file = path.join(SHIPPED_SHOW_DIR, seasonDir(entry.codes[j]), finalName(entry.codes[j], entry.titles[j]));
      const v = await verifyRip(file, null, { minBytes: 0 });
      if (!v.ok) return null;
      sum += v.duration_s;
    }
    if (Math.abs(scanned[i].duration_s - sum) > 10) return false;
  }
  return true;
}

/**
 * Pair a disc manifest against on-disc titles: entries must appear as an
 * ordered subsequence of episode-length titles. Titles that fit no entry
 * (play-all compilations, 30min featurettes) are skipped, not counted.
 */
function matchDisc(discDef, titles) {
  const eps = titles.filter((t) => t.duration_s >= MIN_EP_S);
  const pairs = [];
  let ti = 0;
  for (const entry of discDef.entries) {
    const expected = entry.codes.length * AVG_EP_S;
    while (ti < eps.length && Math.abs(eps[ti].duration_s - expected) > tolerance(expected)) ti += 1;
    if (ti >= eps.length) return null;
    pairs.push({ entry, title: eps[ti] });
    ti += 1;
  }
  // Exact duration signature (±5s per title), for discs whose shape is not
  // unique. Recovered from prior rips; a sig mismatch rejects the candidate.
  if (discDef.sig) {
    if (discDef.sig.length !== pairs.length) return null;
    for (let i = 0; i < pairs.length; i += 1) {
      if (Math.abs(pairs[i].title.duration_s - discDef.sig[i]) > 5) return null;
    }
  }
  return pairs;
}

/**
 * These discs write no chapter atoms into the MKV (makemkv scan says "2" but
 * the container ends up chapterless), so multi-episode titles are split at
 * detected episode boundaries: fade-to-black overlapping silence nearest the
 * expected split point.
 */
// Episode segments inside a multi-ep title are NOT always equal length (the
// S05E18-20 finale special runs 19:37/22:37/25:18), so windowed search around
// k*dur/n can miss every real fade. And the fades are often dark-but-not-black
// (pix_th 0.10 saw nothing on disc 18; 0.15 finds them). One full-file
// black-scan, then pick the boundary combination where every resulting
// segment is a plausible episode length, preferring the longest fades.
const EP_SEG_MIN_S = 14 * 60;
const EP_SEG_MAX_S = 32 * 60;
async function detectBoundaries(file, duration_s, nParts) {
  const { spawn } = await import('node:child_process');
  const stderr = await new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-i', file,
      '-vf', 'blackdetect=d=0.2:pix_th=0.15', '-an', '-f', 'null', '-']);
    let out = '';
    p.stderr.on('data', (c) => { out += c; });
    p.on('error', rej);
    p.on('close', () => res(out));
  });
  const blacks = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]) }))
    .map((b) => ({ mid: (b.start + b.end) / 2, dur: b.end - b.start }))
    // intro/credits fades can't be episode boundaries
    .filter((b) => b.mid > EP_SEG_MIN_S && b.mid < duration_s - EP_SEG_MIN_S);
  const segmentsOk = (mids) => [0, ...mids, duration_s]
    .every((v, i, arr) => i === 0 || (arr[i] - arr[i - 1] >= EP_SEG_MIN_S && arr[i] - arr[i - 1] <= EP_SEG_MAX_S));
  // strong fades first; relax to weak ones only if no valid combination
  for (const minDur of [0.4, 0.2]) {
    const cands = blacks.filter((b) => b.dur >= minDur);
    let best = null;
    const pick = (startIdx, chosen) => {
      if (chosen.length === nParts - 1) {
        if (!segmentsOk(chosen.map((c) => c.mid))) return;
        const score = chosen.reduce((s, c) => s + c.dur, 0);
        if (!best || score > best.score) best = { score, mids: chosen.map((c) => c.mid) };
        return;
      }
      for (let i = startIdx; i < cands.length; i += 1) pick(i + 1, [...chosen, cands[i]]);
    };
    pick(0, []);
    if (best) return best.mids;
  }
  throw new Error(`no black-fade combination yields ${nParts} episode-length segments (${blacks.length} fades seen)`);
}

function fmtTs(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${h}:${m}:${sec}`;
}

async function splitAtTimestamps(mkvPath, boundaries_s, destDir, baseName) {
  const { spawn } = await import('node:child_process');
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  const output = path.join(destDir, `${baseName}.mkv`);
  await new Promise((res, rej) => {
    const p = spawn('mkvmerge', ['-o', output, '--split', `timestamps:${boundaries_s.map(fmtTs).join(',')}`, mkvPath]);
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => { err += c; });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 || code === 1 ? res() : rej(new Error(`mkvmerge exited ${code}: ${err.slice(-400)}`))));
  });
  return (await fsp.readdir(destDir)).filter((n) => n.endsWith('.mkv')).sort()
    .map((n) => path.join(destDir, n));
}

const inFlight = new Set();

async function identifyDisc(titles, done, discLabel) {
  const candidates = DISCS
    .filter((d) => !done[d.disc] && !inFlight.has(d.disc))
    // A manifest disc with a pinned volume label only matches that label
    // (labels are non-unique in this set, so pins narrow, never widen).
    .filter((d) => !d.label || d.label === discLabel)
    .map((d) => ({ def: d, pairs: matchDisc(d, titles) }))
    .filter((c) => c.pairs);
  if (!candidates.length) return null;
  // Discs arrive in sheet order; identical shapes resolve to the lowest unripped.
  candidates.sort((a, b) => a.def.disc - b.def.disc);
  return { def: candidates[0].def, pairs: candidates[0].pairs, ambiguous: candidates.length > 1 };
}

async function processDisc(drive) {
  const { index, osDevice, discLabel } = drive;
  // NB: volume labels are NOT unique across this set (several discs are just
  // "TEENAGE_MUTANT_NINJA_TURTLES"), so identity comes from shape-matching
  // against unripped manifest discs — never from the label.
  const done = await loadDone();
  // Reinserted-disc guard: a non-generic label matching a DONE disc means this
  // disc is already ripped — without this, its shape can match a FUTURE disc
  // (disc 13 nearly re-ripped as disc 15 during region testing).
  const GENERIC = 'TEENAGE_MUTANT_NINJA_TURTLES';
  const doneMatch = discLabel && discLabel !== GENERIC
    && Object.values(done).find((d) => d.label === discLabel);
  let prescan = null;
  if (doneMatch) {
    prescan = await scanDiscSafe(index);
    if (!prescan.titles.length) {
      await notify(`♻️ ${discLabel} matches done disc ${doneMatch.disc} and won't scan — ignoring it. Re-insert to retry.`);
      return { skip: discLabel };
    }
    const same = await isSameAsDoneDisc(doneMatch.disc, prescan.titles);
    if (same !== false) {
      // true = confirmed reinsert; null = can't reach shipped files to compare — fail safe.
      await notify(`♻️ ${discLabel} is already ripped (disc ${doneMatch.disc}) — ignoring it. Swap in an unripped disc when ready.`);
      return { skip: discLabel };
    }
    await notify(`🔁 ${discLabel} shares done disc ${doneMatch.disc}'s label but not its content (2-disc set) — treating as a new disc.`);
  }

  const thread = await DiscThread.start({ driveId: osDevice.replace('/dev/r', ''), discLabel });
  try {
    await thread.step(2, 'disc analyze');
    const scan = prescan ?? await scanDiscSafe(index);
    const identified = await identifyDisc(scan.titles, done, discLabel);
    if (!identified) {
      const shape = scan.titles.map((t) => `${t.id}:${Math.round(t.duration_s / 60)}m`).join(' ');
      throw new Error(`cannot match ${discLabel} against manifest (titles: ${shape})`);
    }
    const { def, pairs, ambiguous } = identified;
    inFlight.add(def.disc);
    try {
      await thread.step(2, 'disc analyze', { volTitle: `Disc ${def.disc}` });
      await thread.milestone(
        `Identified as sheet Disc ${def.disc} (${episodeCount(def)} eps, ${pairs.length} titles)` +
        (ambiguous ? ' — shape was ambiguous, chose lowest unripped; will be caught at verify if wrong.' : ''),
      );

      const discDir = path.join(STAGING, `disc-${String(def.disc).padStart(2, '0')}`);
      await fsp.mkdir(discDir, { recursive: true });
      const outputs = [];

      await thread.step(3, 'ripping episodes');
      for (const [i, { entry, title }] of pairs.entries()) {
        // Resume support: a prior attempt may have left a good rip in staging.
        const prior = title.outName ? path.join(discDir, title.outName) : null;
        let outFile = null;
        if (prior) {
          const v = await verifyRip(prior, title.duration_s);
          if (v.ok) outFile = prior;
          else await fsp.rm(prior, { force: true });
        }
        if (outFile) {
          await thread.milestone(`reusing prior rip ${i + 1}/${pairs.length}: ${entry.titles[0]}`);
        } else {
          // "Failed to open disc" happens transiently right after a killed
          // makemkvcon or a fast disc swap — settle and retry before failing.
          try {
            ({ outFile } = await makemkv.ripTitle({ index, titleId: title.id, destDir: discDir }));
          } catch (ripErr) {
            if (!/Failed to open disc/i.test(ripErr.message)) throw ripErr;
            await thread.milestone(`drive busy (${entry.titles[0]}); retrying in 20s`);
            await new Promise((r) => setTimeout(r, 20_000));
            ({ outFile } = await makemkv.ripTitle({ index, titleId: title.id, destDir: discDir }));
          }
          await thread.milestone(`ripped ${i + 1}/${pairs.length}: ${entry.titles[0]}${entry.codes.length > 1 ? ` (+${entry.codes.length - 1} more, will split)` : ''}`);
        }
        outputs.push({ entry, title, outFile });
      }

      // Disc is fully read — free the drive NOW; split/verify below only
      // touch the staged files. Keeps the swap belt moving.
      try {
        await withInfoLock(() => makemkv.eject(osDevice, drive.driveName));
        await thread.milestone('💿 drive ejected — feed the next disc; finishing split/verify from staging');
      } catch (ejectErr) {
        await thread.milestone(`eject hiccup (${ejectErr.message}) — eject manually when the tray allows.`);
      }

      await thread.step(4, 'splitting + naming');
      const finals = [];
      for (const { entry, title, outFile } of outputs) {
        if (entry.codes.length === 1) {
          finals.push({ code: entry.codes[0], title: entry.titles[0], file: outFile, expected_s: title.duration_s });
          continue;
        }
        const chapters = await readChapters(outFile);
        let parts;
        // Chapter atoms exist on some discs but are junk (disc 18: marks at
        // 8s/175s/3777s) — only trust them if every resulting segment is a
        // plausible episode length.
        const chapterGroups = chapters.length >= entry.codes.length
          ? groupChapters(chapters, entry.codes.length) : null;
        const groupSegSane = chapterGroups?.every((g) => {
          const seg = chapters[g.at(-1)].end_s - chapters[g[0]].start_s;
          return seg >= EP_SEG_MIN_S && seg <= EP_SEG_MAX_S;
        });
        if (chapterGroups && groupSegSane) {
          parts = await splitAtChapters(outFile, chapterGroups, path.join(discDir, 'split'), entry.codes.join('_'));
        } else {
          if (chapterGroups) await thread.milestone(`${entry.codes.join('+')}: chapter atoms are degenerate — using black-scan boundaries instead`);
          const bounds = await detectBoundaries(outFile, title.duration_s, entry.codes.length);
          await thread.milestone(`${entry.codes.join('+')}: no chapters in MKV — splitting at detected black+silence boundary (${bounds.map((b) => fmtTs(b)).join(', ')})`);
          parts = await splitAtTimestamps(outFile, bounds, path.join(discDir, 'split'), entry.codes.join('_'));
        }
        if (parts.length !== entry.codes.length) {
          throw new Error(`${entry.codes.join('+')}: split produced ${parts.length} files, expected ${entry.codes.length}`);
        }
        entry.codes.forEach((code, j) => {
          // expected_s null: segments are legitimately unequal (finale
          // special is 19:37/22:37/25:18), so ±2min-of-average would reject
          // honest splits. Episode-length sanity is enforced at split time.
          finals.push({ code, title: entry.titles[j], file: parts[j], expected_s: null });
        });
      }

      await thread.step(6, 'verify + hand off');
      for (const f of finals) {
        const v = await verifyRip(f.file, f.expected_s);
        if (!v.ok) throw new Error(`${f.code} failed verify: ${v.reason}`);
        const destDir = path.join(READY, SHOW_NAME, seasonDir(f.code));
        await fsp.mkdir(destDir, { recursive: true });
        await fsp.rename(f.file, path.join(destDir, finalName(f.code, f.title)));
      }
      await fsp.rm(discDir, { recursive: true, force: true });

      // Re-load before saving: `done` is a snapshot from when this disc STARTED,
      // and the other drive may have finished a disc since — saving the stale
      // snapshot erases that record (this exact race shipped disc 9 as disc 8).
      const fresh = await loadDone();
      fresh[def.disc] = { disc: def.disc, label: discLabel, at: new Date().toISOString(), eps: finals.map((f) => f.code) };
      await saveDone(fresh);
      await logEvent({ event: 'disc-done', disc: def.disc, label: discLabel, eps: finals.map((f) => f.code) });

      const remaining = DISCS.filter((d) => !fresh[d.disc]).map((d) => d.disc);
      await thread.success(
        `✅ Disc ${def.disc} done — ${finals.map((f) => f.code).join(', ')} handed to copy watcher.\n` +
        (remaining.length
          ? `💿 Ejected. Next up per sheet: Disc ${remaining[0]} (${remaining.length} to go).`
          : '🎉 That was the last disc! All 20 ripped.'),
      );
      return { disc: def.disc };
    } finally {
      inFlight.delete(def.disc);
    }
  } catch (err) {
    const text = `❌ ${discLabel || 'disc'}: ${err.message}. Disc left in drive; fix + it will retry on next insert (or eject/reinsert).`;
    if (isLiveThread(thread)) await thread.fail(text); else await notify(text);
    await logEvent({ event: 'disc-fail', label: discLabel, error: err.message });
    return { error: err.message, label: discLabel };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function watch() {
  const release = await acquireWatchLock();
  await fsp.mkdir(STAGING, { recursive: true });
  await fsp.mkdir(READY, { recursive: true });
  const failedLabels = new Set();
  const skippedLabels = new Set();
  const busy = new Set();
  const lastLabel = new Map();

  await notify(`🐢 TMNT (2012) ripper watching both drives. Staging: ${STAGING}`);
  process.on('SIGINT', async () => { await release(); process.exit(0); });
  process.on('SIGTERM', async () => { await release(); process.exit(0); });

  for (;;) {
    const ignore = (process.env.RIPPER_IGNORE_DRIVES || '').split(',').filter(Boolean);
    let drives = [];
    try {
      drives = (await withInfoLock(() => makemkv.enumerateDrives()))
        .filter((d) => d.driveName)
        .filter((d) => !ignore.some((p) => d.driveName.includes(p)));
    } catch (err) {
      console.error('enumerate failed:', err.message);
    }
    for (const drive of drives) {
      // Busy/last-seen are keyed by driveName, NOT osDevice: macOS renumbers
      // /dev/diskN on media events, so an osDevice key let the same physical
      // drive re-dispatch mid-rip (two workers, one disc: the second matched
      // the next unripped disc and their reads broke the CSS session).
      const driveKey = drive.driveName;
      // Swapping a disc out clears its failed/skip block so a cleaned disc retries.
      if (!drive.mediaPresent) {
        const last = lastLabel.get(driveKey);
        if (last) { failedLabels.delete(last); skippedLabels.delete(last); lastLabel.delete(driveKey); }
        continue;
      }
      lastLabel.set(driveKey, drive.discLabel);
      if (busy.has(driveKey)) continue;
      if (failedLabels.has(drive.discLabel) || skippedLabels.has(drive.discLabel)) continue;
      busy.add(driveKey);
      processDisc(drive)
        .then((r) => {
          if (r?.error) failedLabels.add(drive.discLabel);
          if (r?.skip) skippedLabels.add(r.skip);
        })
        .catch((err) => console.error('processDisc crashed:', err))
        .finally(() => busy.delete(driveKey));
    }
    const doneCount = Object.keys(await loadDone()).length;
    if (doneCount >= DISCS.length) {
      await notify('🏁 All 20 discs ripped — watcher exiting.');
      break;
    }
    await sleep(POLL_MS);
  }
  await release();
}

const cmd = process.argv[2] || 'watch';
if (cmd === 'watch') {
  watch().catch(async (err) => { console.error(err); process.exit(1); });
} else {
  console.error(`unknown command: ${cmd} (only 'watch')`);
  process.exit(1);
}
