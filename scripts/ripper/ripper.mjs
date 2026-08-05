#!/usr/bin/env node
/**
 * TMNT 2003 two-drive ripping pipeline — world-side CLI.
 * Disc-side modules (robot/makemkv/split) are lazy-imported; inject via setDeps().
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CAMERA_DEVICE,
  CONFIRM_SECOND_FRAME,
  DRIVES,
  OCR_MODEL,
  RIP_EXTRAS,
  SHOW_NAME,
  STAGING_ROOT,
  STATE_DIR,
  THRESHOLDS,
  driveForSlot,
  slotForDrive,
  stagingMounted,
} from './config.mjs';
import { capture } from './lib/camera.mjs';
import { scanBoxes, validateOcrPayload } from './lib/ocr.mjs';
import { notify } from './lib/slack.mjs';
import { DiscThread, isLiveThread } from './lib/discthread.mjs';
import {
  loadState,
  saveState,
  acquireWatchLock,
  acquireDriveLock,
  logEvent,
} from './lib/state.mjs';
import {
  buildFinalizePlan,
  applyFinalizePlan,
} from './lib/finalize.mjs';

/** Fail via disc thread when live; else channel notify. */
async function discFail(thread, text) {
  if (isLiveThread(thread)) await thread.fail(text);
  else await notify(text);
}

/** @type {null | { makemkv: any, split: any }} */
let injectedDeps = null;

/** Test/integration: inject disc-side modules (or stubs). */
export function setDeps(deps) {
  injectedDeps = deps;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadDiscSide() {
  if (injectedDeps) return injectedDeps;
  try {
    const [makemkv, split] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, 'lib', 'makemkv.mjs')).href),
      import(pathToFileURL(path.join(__dirname, 'lib', 'split.mjs')).href),
    ]);
    injectedDeps = { makemkv, split };
    return injectedDeps;
  } catch (err) {
    const stub = {
      enumerateDrives: async () => {
        throw new Error(`disc-side unavailable: ${err.message}`);
      },
      resolveDrive: async () => {
        throw new Error(`disc-side unavailable: ${err.message}`);
      },
      scanDisc: async () => {
        throw new Error(`disc-side unavailable: ${err.message}`);
      },
      ripTitle: async () => {
        throw new Error(`disc-side unavailable: ${err.message}`);
      },
      classifyTitles: () => ({
        mode: 'unknown',
        episodeTitleIds: [],
        playallId: null,
        extraIds: [],
      }),
      eject: async () => {
        throw new Error(`disc-side unavailable: ${err.message}`);
      },
      readChapters: async () => [],
      groupChapters: () => [],
      splitAtChapters: async () => [],
      verifyRip: async () => ({ ok: false, duration_s: 0, reason: 'no split.mjs' }),
    };
    injectedDeps = {
      makemkv: stub,
      split: stub,
      _missing: true,
      _error: err,
    };
    return injectedDeps;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'help';
  const flags = {};
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--apply') flags.apply = true;
    else if (a === '--trust-title-order') flags.trustTitleOrder = true;
    else if (a === '--no-extras') flags.noExtras = true;
    else if (a === '--slot' && args[i + 1]) flags.slot = args[++i];
    else if (a === '--drive' && args[i + 1]) flags.drive = args[++i];
    else if (a === '--expect-eps' && args[i + 1]) flags.expectEps = Number(args[++i]);
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positionals.push(a);
  }
  return { cmd, flags, positionals };
}

function whichSync(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureDirs() {
  await fsp.mkdir(STAGING_ROOT, { recursive: true });
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.mkdir(path.join(STATE_DIR, 'scans'), { recursive: true });
}

function slugify(s) {
  return String(s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'untitled';
}

function volFolderName(ocr) {
  const n = String(ocr.volume_number).padStart(2, '0');
  const slug = slugify(ocr.volume_title || ocr.episodes?.[0] || 'volume');
  return `vol${n}-${slug}`;
}

function unknownFolderName(discLabel) {
  const safe = slugify(discLabel || 'disc');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `vol-unknown-${safe}-${ts}`;
}

function writeEpisodesMd(ocr, scanId, verified) {
  const lines = [
    `# ${ocr.series || SHOW_NAME} Volume ${ocr.volume_number}`,
    `volume_number: ${ocr.volume_number}`,
    `volume_title: ${ocr.volume_title || ''}`,
    `scan_id: ${scanId}`,
    `verified: ${verified ? 'true' : 'false'}`,
    '',
    ...ocr.episodes.map((e, i) => `${i + 1}. ${e}`),
    '',
  ];
  return lines.join('\n');
}

async function cmdDoctor(flags) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail });
  const bad = (name, detail) => checks.push({ name, ok: false, detail });

  const makemkvcon = process.env.MAKEMKVCON
    || '/Applications/MakeMKV.app/Contents/MacOS/makemkvcon';
  if (fs.existsSync(makemkvcon)) ok('makemkvcon', makemkvcon);
  else bad('makemkvcon', `${makemkvcon} not found`);
  for (const bin of ['imagesnap', 'mkvmerge', 'ffprobe', 'ffmpeg', 'drutil']) {
    const p = whichSync(bin);
    if (p) ok(bin, p);
    else bad(bin, 'not found on PATH');
  }

  if (process.env.GEMINI_API_KEY) ok('GEMINI_API_KEY', 'set');
  else bad('GEMINI_API_KEY', 'missing');
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
    ok('Slack env', `${process.env.SLACK_CHANNEL_NAME || process.env.SLACK_CHANNEL_ID}`);
  } else bad('Slack env', 'SLACK_BOT_TOKEN / SLACK_CHANNEL_ID missing');

  ok('camera', process.env.RIPPER_CAMERA || CAMERA_DEVICE);
  ok('ocr model', process.env.GEMINI_OCR_MODEL || OCR_MODEL);
  ok('drive A', DRIVES.A.driveNamePrefix || '(empty)');
  ok('drive B', DRIVES.B.driveNamePrefix || '(unset — set RIPPER_DRIVE_B_NAME)');
  ok('staging', STAGING_ROOT);
  ok('state', STATE_DIR);

  const mount = stagingMounted();
  if (fs.existsSync(mount)) ok('staging volume', mount);
  else bad('staging volume', `${mount} not mounted`);

  const deps = await loadDiscSide();
  if (deps._missing) bad('disc-side modules', deps._error?.message || 'missing');
  else ok('disc-side modules', 'makemkv.mjs + split.mjs');

  if (flags.full) {
    const sample = path.join(__dirname, 'fixtures', 'sample-box-photo.jpg');
    if (fs.existsSync(sample) && process.env.GEMINI_API_KEY) {
      try {
        const result = await scanBoxes(sample, ['blue', 'red']);
        validateOcrPayload(result.allResults || result.results);
        ok('OCR sample', `scanId=${result.scanId} results=${result.results.length}`);
      } catch (err) {
        bad('OCR sample', err.message);
      }
    } else {
      bad('OCR sample', `missing sample or API key (${sample})`);
    }

    await notify(`ripper doctor --full ok @ ${new Date().toISOString()}`);
    ok('Slack post', 'sent (best-effort; check channel)');

    if (fs.existsSync(mount)) {
      const testFile = path.join(STATE_DIR, `.doctor-${process.pid}.txt`);
      try {
        await fsp.mkdir(STATE_DIR, { recursive: true });
        await fsp.writeFile(testFile, 'doctor\n');
        await fsp.unlink(testFile);
        ok('Seagate write', STATE_DIR);
      } catch (err) {
        bad('Seagate write', err.message);
      }
    }

    if (!deps._missing) {
      try {
        const drives = await deps.makemkv.enumerateDrives();
        ok('info disc:9999', `${drives.length} drive rows`);
      } catch (err) {
        bad('info disc:9999', err.message);
      }
    }
  }

  for (const c of checks) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    process.exitCode = 1;
    console.error(`\ndoctor: ${failed.length} check(s) failed`);
  } else {
    console.log('\ndoctor: all checks passed');
  }
}

/**
 * Scan shelf boxes. Binding only for requested slots (poisoning guard).
 */
async function cmdScan(flags) {
  await ensureDirs();
  const slotArg = (flags.slot || 'both').toLowerCase();
  let requested;
  if (slotArg === 'both') requested = ['blue', 'red'];
  else if (slotArg === 'blue' || slotArg === 'left') requested = ['blue'];
  else if (slotArg === 'red' || slotArg === 'right') requested = ['red'];
  else throw new Error(`--slot must be blue|red|both (got ${slotArg})`);

  const scanDir = path.join(STATE_DIR, 'scans');
  await fsp.mkdir(scanDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const imagePath = path.join(scanDir, `scan-${stamp}.jpg`);

  if (flags.dryRun) {
    console.log(`[dry-run] would capture ${imagePath} slots=${requested.join(',')}`);
    return { dryRun: true, requested };
  }

  return globalScanMutex.run(async () => {
  await capture(imagePath);
  let ocr;
  try {
    ocr = await scanBoxes(imagePath, requested);
  } catch (err) {
    await logEvent({
      type: 'scan_ocr_invalid',
      imagePath,
      error: err.message,
      requested,
    });
    await notify(`⚠️ OCR invalid for slots ${requested.join(',')}: ${err.message}`);
    throw err;
  }

  // Log non-requested slot data; never create/update those folders
  const bound = [];
  for (const r of ocr.results) {
    if (!requested.includes(r.slot)) continue;
    const drive = driveForSlot(r.slot);
    const folderName = volFolderName(r);
    const folder = path.join(STAGING_ROOT, folderName);
    await fsp.mkdir(folder, { recursive: true });
    const verified = r.confidence >= THRESHOLDS.ocrConfidenceMin;
    await fsp.writeFile(
      path.join(folder, 'episodes.md'),
      writeEpisodesMd(r, ocr.scanId, verified),
      'utf8',
    );
    const manifest = {
      scan_id: ocr.scanId,
      discLabel: null,
      driveName: drive.driveNamePrefix || null,
      slot: r.slot,
      ocr: { ...r, verified },
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      path.join(folder, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    bound.push({ slot: r.slot, folder, verified, volume_number: r.volume_number });
    await logEvent({
      type: 'scan_bound',
      scanId: ocr.scanId,
      slot: r.slot,
      folder,
      verified,
    });
  }

  for (const r of ocr.allResults || []) {
    if (!requested.includes(r.slot)) {
      await logEvent({
        type: 'scan_ignored_slot',
        scanId: ocr.scanId,
        slot: r.slot,
        volume_number: r.volume_number,
        note: 'poisoning guard — not requested',
      });
    }
  }

  console.log(JSON.stringify({ scanId: ocr.scanId, imagePath, bound }, null, 2));
  return { ocr, bound, imagePath };
  });
}

const globalScanMutex = createMutex();

/**
 * Disc-open gate: makemkvcon's disc-opening/analyze phase must never overlap
 * another makemkvcon invocation (spec Review-resolution 3). Writing (PRGV
 * progress flowing) is allowed to overlap, so ripTitleGated releases the gate
 * on the first PRGV record.
 */
const discGate = (() => {
  let tail = Promise.resolve();
  return {
    acquire() {
      let release;
      const held = new Promise((r) => { release = r; });
      const prev = tail;
      tail = tail.then(() => held);
      return prev.then(() => release);
    },
  };
})();

async function gated(fn) {
  const release = await discGate.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

async function ripTitleGated(deps, opts) {
  const release = await discGate.acquire();
  let opened = false;
  const open = () => {
    if (!opened) {
      opened = true;
      release();
    }
  };
  try {
    return await deps.makemkv.ripTitle({
      ...opts,
      onProgress: (p) => {
        open();
        opts.onProgress?.(p);
      },
    });
  } finally {
    open();
  }
}

// OCR capitalization/punctuation jitters between frames ("From The" vs "from the")
// even at high confidence — compare normalized, not raw (live bug on vol 5's box).
function settleFramesAgree(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return a.volume_number === b.volume_number && norm(a.volume_title) === norm(b.volume_title);
}

async function settleScan(slot, { dryRun }) {
  return globalScanMutex.run(async () => {
  const requested = [slot];
  if (dryRun) return { ocr: null, confirmed: false };

  const scanDir = path.join(STATE_DIR, 'scans');
  await fsp.mkdir(scanDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const img1 = path.join(scanDir, `settle-${slot}-${stamp}-a.jpg`);
  await capture(img1);
  const first = await scanBoxes(img1, requested);
  const r1 = first.results.find((r) => r.slot === slot);

  if (!CONFIRM_SECOND_FRAME) {
    return { ocr: first, result: r1, confirmed: Boolean(r1) };
  }

  await sleep(THRESHOLDS.confirmFrameDelayMs);
  const img2 = path.join(scanDir, `settle-${slot}-${stamp}-b.jpg`);
  await capture(img2);
  let second;
  try {
    second = await scanBoxes(img2, requested);
  } catch {
    return { ocr: first, result: r1, confirmed: false, reason: 'second frame OCR failed' };
  }
  const r2 = second.results.find((r) => r.slot === slot);
  if (r1 && r2 && settleFramesAgree(r1, r2)) {
    return { ocr: second, result: r2, confirmed: true };
  }
  // retry once
  await sleep(THRESHOLDS.confirmFrameDelayMs);
  const img3 = path.join(scanDir, `settle-${slot}-${stamp}-c.jpg`);
  await capture(img3);
  const third = await scanBoxes(img3, requested);
  const r3 = third.results.find((r) => r.slot === slot);
  if (r1 && r3 && settleFramesAgree(r1, r3)) {
    return { ocr: third, result: r3, confirmed: true };
  }
  return {
    ocr: third,
    result: r3 || r1,
    confirmed: false,
    reason: 'settle frames disagree on volume_number/title',
  };
  });
}

async function cmdRip(flags) {
  const driveId = String(flags.drive || '').toUpperCase();
  if (driveId !== 'A' && driveId !== 'B') {
    throw new Error('rip requires --drive A|B');
  }
  const driveCfg = DRIVES[driveId];
  if (!driveCfg.driveNamePrefix) {
    throw new Error(`drive ${driveId} name unset (RIPPER_DRIVE_${driveId}_NAME)`);
  }

  const release = await acquireDriveLock(driveId);
  try {
    await ensureDirs();
    const deps = await loadDiscSide();
    if (deps._missing) throw new Error('disc-side modules missing');

    if (flags.dryRun) {
      console.log(`[dry-run] rip drive ${driveId} prefix=${driveCfg.driveNamePrefix}`);
      return;
    }

    const resolved = await gated(() => deps.makemkv.resolveDrive(driveCfg.driveNamePrefix));
    if (!resolved.mediaPresent) {
      throw new Error(`drive ${driveId}: no media present`);
    }

    // One Slack thread per disc; dies with process (not persisted).
    const thread = await DiscThread.start({
      driveId,
      discLabel: resolved.discLabel,
      volTitle: null,
    });

    await saveState((s) => {
      s.drives[driveId] = {
        ...s.drives[driveId],
        status: 'IDENTIFYING',
        driveName: driveCfg.driveNamePrefix,
        osDevice: resolved.osDevice,
        discLabel: resolved.discLabel,
      };
      return s;
    });

    const slot = slotForDrive(driveId).slot;
    let ocrResult = null;
    let scanId = null;
    let folderName = unknownFolderName(resolved.discLabel);
    let ocrVerified = false;

    try {
      const settled = await settleScan(slot, { dryRun: false });
      if (settled.confirmed && settled.result) {
        ocrResult = settled.result;
        scanId = settled.ocr.scanId;
        if (ocrResult.confidence >= THRESHOLDS.ocrConfidenceMin) {
          folderName = volFolderName(ocrResult);
          ocrVerified = true;
        }
        // First edit can attach volTitle once OCR settles.
        await thread.step(1, 'box scan', {
          discLabel: resolved.discLabel,
          volTitle: ocrResult.volume_title || null,
        });
      } else {
        await saveState((s) => {
          s.drives[driveId] = {
            ...s.drives[driveId],
            status: 'NEEDS_ATTENTION',
            reason: settled.reason || 'OCR settle failed',
          };
          return s;
        });
        await discFail(
          thread,
          `⚠️ Drive ${driveId} NEEDS_ATTENTION: ${settled.reason || 'OCR settle failed'}. Ripping into neutral folder.`,
        );
      }
    } catch (err) {
      await notify(
        `⚠️ Drive ${driveId} OCR failed (${err.message}); ripping into neutral folder.`,
      );
    }

    const folder = path.join(STAGING_ROOT, folderName);
    await fsp.mkdir(folder, { recursive: true });
    if (ocrResult && scanId) {
      await fsp.writeFile(
        path.join(folder, 'episodes.md'),
        writeEpisodesMd(ocrResult, scanId, ocrVerified),
        'utf8',
      );
    }

    await thread.step(2, 'disc analyze', {
      discLabel: resolved.discLabel,
      volTitle: ocrResult?.volume_title || null,
    });
    console.log(`scanning disc on ${driveId} (index ${resolved.index})…`);
    let info = await gated(() => deps.makemkv.scanDisc(resolved.index));
    const expectEps =
      flags.expectEps || ocrResult?.episodes?.length || undefined;
    let classification = deps.makemkv.classifyTitles(info.titles, expectEps);

    if (classification.mode === 'unknown') {
      // Transient partial scans happen (vol 7 read 3-of-4 titles on first try,
      // clean on retry — likely the drive still settling). One re-scan before
      // escalating to a human.
      console.log(`unknown layout on ${driveId}; re-scanning once in 30s…`);
      await sleep(30_000);
      info = await gated(() => deps.makemkv.scanDisc(resolved.index));
      classification = deps.makemkv.classifyTitles(info.titles, expectEps);
    }

    if (classification.mode === 'unknown') {
      await saveState((s) => {
        s.drives[driveId] = {
          ...s.drives[driveId],
          status: 'NEEDS_ATTENTION',
          reason: 'unknown title layout',
          classification,
        };
        return s;
      });
      await discFail(
        thread,
        `⚠️ Drive ${driveId} NEEDS_ATTENTION: unknown disc layout for "${info.discLabel}"`,
      );
      return;
    }

    const titleCount =
      classification.mode === 'playall'
        ? 1
        : (classification.episodeTitleIds?.length || 0);
    await thread.milestone(
      `disc analyze: mode=${classification.mode}, titles=${titleCount} (extras=${classification.extraIds?.length || 0})`,
    );

    // Label vs OCR disagreement ⇒ NEEDS_ATTENTION, keep neutral folder semantics
    if (
      ocrVerified &&
      info.discLabel &&
      ocrResult &&
      !labelsAgree(info.discLabel, ocrResult)
    ) {
      ocrVerified = false;
      const neutral = path.join(STAGING_ROOT, unknownFolderName(info.discLabel));
      await fsp.rename(folder, neutral).catch(async () => {
        await fsp.mkdir(neutral, { recursive: true });
      });
      await discFail(
        thread,
        `⚠️ Drive ${driveId} label/OCR disagree (label="${info.discLabel}" vol=${ocrResult.volume_number}). NEEDS_ATTENTION; neutral folder.`,
      );
      await saveState((s) => {
        s.drives[driveId] = {
          ...s.drives[driveId],
          status: 'NEEDS_ATTENTION',
          reason: 'label/OCR mismatch',
          folder: neutral,
        };
        return s;
      });
      return await runRipPipeline({
        deps,
        driveId,
        resolved,
        info,
        classification,
        folder: fs.existsSync(neutral) ? neutral : folder,
        ocrResult,
        scanId,
        ocrVerified: false,
        ripExtras: flags.noExtras ? false : RIP_EXTRAS,
        expectEps,
        thread,
      });
    }

    return await runRipPipeline({
      deps,
      driveId,
      resolved,
      info,
      classification,
      folder,
      ocrResult,
      scanId,
      ocrVerified,
      ripExtras: flags.noExtras ? false : RIP_EXTRAS,
      expectEps,
      thread,
    });
  } finally {
    await release();
  }
}

function labelsAgree(discLabel, ocr) {
  const a = String(discLabel).toLowerCase();
  // Prefer an explicit "vol N" number in the label — exact compare beats substring
  // (label "TMNT vol 12" must NOT agree with OCR vol 1).
  const m = /vol(?:ume)?\D*0*(\d+)/i.exec(a);
  if (m) return Number(m[1]) === ocr.volume_number;
  const n = String(ocr.volume_number);
  return a.includes(`vol ${n}`) || a.includes(`vol${n}`) || a.includes(n);
}

async function runRipPipeline({
  deps,
  driveId,
  resolved,
  info,
  classification,
  folder,
  ocrResult,
  scanId,
  ocrVerified,
  ripExtras,
  expectEps,
  thread = null,
}) {
  const attemptDirs = (await fsp.readdir(folder).catch(() => [])).filter((n) =>
    /^attempt-\d+$/i.test(n),
  );
  const attemptN = attemptDirs.length + 1;
  const attemptDir = path.join(folder, `attempt-${attemptN}`);
  await fsp.mkdir(attemptDir, { recursive: true });

  await thread?.step(3, 'ripping episodes', {
    discLabel: info.discLabel,
    volTitle: ocrResult?.volume_title || null,
  });
  await saveState((s) => {
    s.drives[driveId] = {
      ...s.drives[driveId],
      status: 'RIPPING',
      folder,
      attemptDir,
      driveName: resolved.driveName || DRIVES[driveId].driveNamePrefix,
      osDevice: resolved.osDevice,
      discLabel: info.discLabel,
    };
    return s;
  });

  const expectedOutputs = [];
  const titleIds =
    classification.mode === 'playall'
      ? [classification.playallId]
      : classification.episodeTitleIds;

  const manifest = {
    discLabel: info.discLabel,
    driveName: DRIVES[driveId].driveNamePrefix,
    osDevice: resolved.osDevice,
    scan_id: scanId,
    mode: classification.mode,
    selectedTitleIds: titleIds,
    titles: info.titles,
    classification,
    ocr: ocrResult
      ? { ...ocrResult, verified: ocrVerified }
      : { verified: false },
    expectedOutputs: [],
    verify: [],
    chapterGrouping: null,
    attempt: attemptN,
    createdAt: new Date().toISOString(),
  };

  try {
    let playallFile = null;
    for (const titleId of titleIds) {
      const { outFile } = await ripTitleGated(deps, {
        index: resolved.index,
        titleId,
        destDir: attemptDir,
        onProgress: (p) => {
          // PRGV:current,total,max — total is the whole-operation bar
          const total = Number(p?.fields?.[1]);
          const max = Number(p?.fields?.[2]);
          if (max > 0) process.stdout.write(`\rrip t${titleId} ${((total / max) * 100).toFixed(0)}%   `);
        },
      });
      process.stdout.write('\n');
      const tinfo = info.titles.find((t) => t.id === titleId);
      const expected_s = tinfo?.duration_s;
      await saveState((s) => {
        s.drives[driveId] = { ...s.drives[driveId], status: 'VERIFYING' };
        return s;
      });
      const v = await deps.split.verifyRip(outFile, expected_s);
      manifest.verify.push({ file: outFile, ...v });
      if (!v.ok) throw new Error(`verify failed: ${v.reason || outFile}`);
      if (classification.mode === 'playall') playallFile = outFile;
      else {
        expectedOutputs.push(outFile);
      }
    }

    if (classification.mode === 'playall' && playallFile) {
      await thread?.step(4, 'splitting');
      await saveState((s) => {
        s.drives[driveId] = { ...s.drives[driveId], status: 'SPLITTING' };
        return s;
      });
      const n = expectEps || ocrResult?.episodes?.length || Math.round(
        (info.titles.find((t) => t.id === classification.playallId)?.duration_s || 3600) /
          (22 * 60),
      );
      const chapters = await deps.split.readChapters(playallFile);
      const groups = deps.split.groupChapters(chapters, n);
      manifest.chapterGrouping = groups;
      const files = await deps.split.splitAtChapters(
        playallFile,
        groups,
        attemptDir,
        'ep',
      );
      if (files.length !== groups.length) {
        throw new Error(`split produced ${files.length} files for ${groups.length} chapter groups`);
      }
      for (let i = 0; i < files.length; i++) {
        const groupDur = groups[i].reduce(
          (sum, ci) => sum + (chapters[ci].end_s - chapters[ci].start_s), 0);
        const v = await deps.split.verifyRip(files[i], groupDur);
        manifest.verify.push({ file: files[i], ...v });
        if (!v.ok) throw new Error(`split verify failed: ${v.reason || files[i]}`);
      }
      expectedOutputs.push(...files);
      // promote ep files to folder root for finalize
      const promoted = [];
      for (let i = 0; i < files.length; i++) {
        const dest = path.join(folder, `ep-${String(i + 1).padStart(2, '0')}.mkv`);
        // rename is instant on the same volume; copy only if rename fails
        await fsp.rename(files[i], dest).catch(async () => {
          await fsp.copyFile(files[i], dest);
        });
        promoted.push(dest);
      }
      manifest.outputs = promoted.map((p) => path.basename(p));
      const splitMinutes = [];
      for (let i = 0; i < files.length; i++) {
        const groupDur = groups[i].reduce(
          (sum, ci) => sum + (chapters[ci].end_s - chapters[ci].start_s), 0);
        splitMinutes.push(`ep-${String(i + 1).padStart(2, '0')}=${(groupDur / 60).toFixed(1)}m`);
      }
      await thread?.milestone(`split: ${splitMinutes.join(', ')}`);
    } else {
      const promoted = [];
      for (let i = 0; i < expectedOutputs.length; i++) {
        const dest = path.join(folder, `ep-${String(i + 1).padStart(2, '0')}.mkv`);
        await fsp.rename(expectedOutputs[i], dest).catch(async () => {
          await fsp.copyFile(expectedOutputs[i], dest);
        });
        promoted.push(dest);
      }
      manifest.outputs = promoted.map((p) => path.basename(p));
    }

    if (ripExtras && classification.extraIds?.length) {
      await thread?.step(5, 'extras');
      const extrasDir = path.join(folder, 'extras');
      await fsp.mkdir(extrasDir, { recursive: true });
      let extrasOk = 0;
      for (const titleId of classification.extraIds) {
        try {
          await ripTitleGated(deps, {
            index: resolved.index,
            titleId,
            destDir: extrasDir,
          });
          extrasOk += 1;
        } catch (err) {
          console.warn(`extras title ${titleId} failed:`, err.message);
        }
      }
      await thread?.milestone(`extras done: ${extrasOk}/${classification.extraIds.length}`);
    }

    await thread?.step(6, 'verify+eject');
    manifest.expectedOutputs = manifest.outputs;
    await fsp.writeFile(
      path.join(folder, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    await gated(() => deps.makemkv.eject(resolved.osDevice));

    await saveState((s) => {
      s.drives[driveId] = {
        ...s.drives[driveId],
        status: 'DONE_EJECTED',
        folder,
        finishedAt: new Date().toISOString(),
      };
      return s;
    });

    const minutes = [];
    for (const name of manifest.outputs || []) {
      const fp = path.join(folder, name);
      try {
        const v = await deps.split.verifyRip(fp, null);
        minutes.push(`${name.replace(/\.mkv$/i, '')}=${((v.duration_s || 0) / 60).toFixed(1)}m`);
      } catch {
        minutes.push(name);
      }
    }

    const successText =
      `✅ Drive ${driveId} done: ${info.discLabel} → ${path.basename(folder)}\n${minutes.join(', ')}\nProtocol: put the next box in this drive's shelf slot BEFORE closing the tray.`;
    if (isLiveThread(thread)) await thread.success(successText);
    else await notify(successText);
    await logEvent({ type: 'rip_success', driveId, folder, discLabel: info.discLabel });

    await saveState((s) => {
      s.drives[driveId] = { status: 'EMPTY' };
      return s;
    });
  } catch (err) {
    await saveState((s) => {
      s.drives[driveId] = {
        ...s.drives[driveId],
        status: 'FAILED_SEATED',
        reason: err.message,
        folder,
        attemptDir,
      };
      return s;
    });
    await discFail(
      thread,
      `❌ Drive ${driveId} FAILED_SEATED: ${err.message} (disc left in tray)`,
    );
    await logEvent({ type: 'rip_failed', driveId, error: err.message, folder });
    throw err;
  }
}

async function cmdFinalize(flags) {
  const plan = await buildFinalizePlan({
    trustTitleOrder: flags.trustTitleOrder,
  });
  console.log(plan.table);
  console.log('');
  if (!plan.ok) {
    console.error('finalize REFUSED:');
    for (const r of plan.reasons) console.error(`  - ${r}`);
    process.exitCode = 1;
    return plan;
  }
  for (const line of plan.mapLines) console.log(line);

  if (flags.apply) {
    if (flags.dryRun) {
      console.log('[dry-run] would apply map');
      return plan;
    }
    const result = await applyFinalizePlan(plan);
    console.log(`applied: moved=${result.moved} map=${result.mapFile} undo=${result.undoFile}`);
  } else {
    console.log('\n(plan only — pass --apply to move)');
  }
  return plan;
}

async function reconcileOnStartup(deps) {
  const state = await loadState();
  let drives = [];
  try {
    drives = await deps.makemkv.enumerateDrives();
  } catch {
    return;
  }
  for (const id of ['A', 'B']) {
    const d = state.drives?.[id];
    if (!d) continue;
    if (d.status === 'RIPPING') {
      // no live child in this process ⇒ FAILED_SEATED, keep attempt dir
      await saveState((s) => {
        s.drives[id] = {
          ...s.drives[id],
          status: 'FAILED_SEATED',
          reason: 'watch restart during RIPPING',
        };
        return s;
      });
      await notify(`❌ Drive ${id} FAILED_SEATED after watch restart (was RIPPING)`);
    }
    if (d.status === 'DRIVE_OFFLINE') {
      const prefix = DRIVES[id].driveNamePrefix;
      if (prefix && drives.some((x) => x.driveName?.includes(prefix))) {
        await saveState((s) => {
          s.drives[id] = { status: 'EMPTY' };
          return s;
        });
      }
    }
  }
}

/**
 * Watch loop: two drive workers + shared scan mutex.
 * Serializes disc-opening while any makemkvcon is in opening/analyze phase.
 */
async function cmdWatch(flags) {
  if (flags.dryRun) {
    console.log('[dry-run] watch would start');
    return;
  }
  const releaseWatch = await acquireWatchLock();
  const deps = await loadDiscSide();
  if (deps._missing) {
    await releaseWatch();
    throw new Error(`cannot watch without disc-side: ${deps._error?.message}`);
  }

  let stopping = false;
  let openingPhase = false;
  let cachedEnum = null;
  const seenMedia = { A: false, B: false };

  const onSignal = async () => {
    if (stopping) return;
    stopping = true;
    await notify('⏹ ripper watch stopping');
    await logEvent({ type: 'watch_stop' });
    await releaseWatch();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  await ensureDirs();
  await reconcileOnStartup(deps);
  await notify(
    `▶️ ripper watch started\nHuman protocol: put the new box in the drive's shelf slot BEFORE closing that drive's tray. When swapping both: place both boxes first, then close both trays.`,
  );
  await logEvent({ type: 'watch_start' });

  async function enumerateSafe() {
    const mount = stagingMounted();
    if (!fs.existsSync(mount)) {
      await notify('⏸ Staging volume unmounted — watch paused');
      await logEvent({ type: 'staging_unmounted' });
      while (!fs.existsSync(mount) && !stopping) await sleep(THRESHOLDS.pollMs);
      if (!stopping) await notify('▶️ Staging volume remounted — watch resumed');
    }
    if (openingPhase) return cachedEnum || [];
    try {
      cachedEnum = await deps.makemkv.enumerateDrives();
      return cachedEnum;
    } catch (err) {
      console.warn('enumerate failed', err.message);
      return cachedEnum || [];
    }
  }

  async function driveWorker(driveId) {
    while (!stopping) {
      try {
        const prefix = DRIVES[driveId].driveNamePrefix;
        if (!prefix) {
          await sleep(THRESHOLDS.pollMs);
          continue;
        }

        const state = await loadState();
        const st = state.drives?.[driveId]?.status || 'EMPTY';
        if (st === 'FAILED_SEATED' || st === 'NEEDS_ATTENTION') {
          // Recovery path: owner physically removes the disc ⇒ back to EMPTY.
          try {
            const r = await gated(() => deps.makemkv.resolveDrive(prefix));
            if (!r.mediaPresent) {
              seenMedia[driveId] = false;
              await saveState((s) => {
                s.drives[driveId] = { status: 'EMPTY' };
                return s;
              });
              await notify(`↩️ Drive ${driveId} cleared (disc removed) — ready for the next disc`);
            }
          } catch {
            /* keep state; drive may be busy/offline */
          }
          await sleep(THRESHOLDS.pollMs);
          continue;
        }
        if (['RIPPING', 'VERIFYING', 'SPLITTING', 'IDENTIFYING', 'SETTLING'].includes(st)) {
          await sleep(THRESHOLDS.pollMs);
          continue;
        }

        let resolved;
        try {
          resolved = await gated(() => deps.makemkv.resolveDrive(prefix));
        } catch (err) {
          if (/ambiguous|not found|no drive/i.test(err.message)) {
            await saveState((s) => {
              s.drives[driveId] = { status: 'DRIVE_OFFLINE', reason: err.message };
              return s;
            });
          }
          await sleep(THRESHOLDS.pollMs);
          continue;
        }

        const present = Boolean(resolved.mediaPresent);
        const rising = present && !seenMedia[driveId];
        seenMedia[driveId] = present;

        if (!rising) {
          await sleep(THRESHOLDS.pollMs);
          continue;
        }

        await saveState((s) => {
          s.drives[driveId] = {
            status: 'SETTLING',
            driveName: prefix,
            osDevice: resolved.osDevice,
            discLabel: resolved.discLabel,
          };
          return s;
        });
        await sleep(THRESHOLDS.settleMs);

        // re-check still present
        try {
          resolved = await gated(() => deps.makemkv.resolveDrive(prefix));
        } catch {
          await saveState((s) => {
            s.drives[driveId] = { status: 'EMPTY' };
            return s;
          });
          continue;
        }
        if (!resolved.mediaPresent) {
          await saveState((s) => {
            s.drives[driveId] = { status: 'EMPTY' };
            return s;
          });
          continue;
        }

        openingPhase = true;
        try {
          await cmdRip({ drive: driveId });
        } catch (err) {
          console.error(`drive ${driveId} rip error`, err.message);
        } finally {
          openingPhase = false;
        }
      } catch (err) {
        console.error(`drive worker ${driveId}`, err);
        await sleep(THRESHOLDS.pollMs);
      }
    }
  }

  // Initial media snapshot so already-loaded discs don't false-trigger rising edge
  try {
    for (const id of ['A', 'B']) {
      const prefix = DRIVES[id].driveNamePrefix;
      if (!prefix) continue;
      try {
        const r = await deps.makemkv.resolveDrive(prefix);
        seenMedia[id] = Boolean(r.mediaPresent);
      } catch {
        seenMedia[id] = false;
      }
    }
  } catch {
    /* ignore */
  }

  await Promise.all([driveWorker('A'), driveWorker('B')]);
}

function createMutex() {
  let chain = Promise.resolve();
  return {
    run(fn) {
      const next = chain.then(fn, fn);
      chain = next.catch(() => {});
      return next;
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp() {
  console.log(`Usage: node ripper.mjs <command> [options]

Commands:
  doctor [--full]              Preflight checks
  scan [--slot blue|red|both]  Capture shelf + OCR (bind requested slots only)
  rip --drive A|B [--expect-eps N] [--no-extras]
  watch                        Dual-drive state machine
  finalize [--apply] [--trust-title-order]

Global:
  --dry-run                    Print actions without camera/makemkv/writes (not for doctor)
`);
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv);
  try {
    switch (cmd) {
      case 'doctor':
        await cmdDoctor(flags);
        break;
      case 'scan':
        await cmdScan(flags);
        break;
      case 'rip':
        await cmdRip(flags);
        break;
      case 'watch':
        await cmdWatch(flags);
        break;
      case 'finalize':
        await cmdFinalize(flags);
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  main();
}

export {
  cmdDoctor,
  cmdScan,
  cmdRip,
  cmdWatch,
  cmdFinalize,
  parseArgs,
  loadDiscSide,
};
