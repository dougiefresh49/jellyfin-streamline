import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const { DISCS, SHOW_NAME } = await import(process.env.DASH_MANIFEST ?? '../data/tmnt-2012-discs.mjs');

const HOST = '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '4242', 10);
const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(HERE, 'index.html');
const LIBRARY = process.env.LOCAL_LIBRARY?.trim() || path.join(HOME, 'Movies', 'library');
const RIPPER_STATE = process.env.DASH_STATE_DIR ?? path.join(LIBRARY, '.ripper-2012');
const STAGING_ROOT = path.join(LIBRARY, 'staging', 'tmnt-2012');
const COPY_ROOT = path.join(LIBRARY, 'ready-to-copy');
const VOICE_ROOT = path.join(LIBRARY, 'voice-lab');

let statusCache = { at: 0, value: null, pending: null };
let drivesCache = { at: 0, value: [] };
const fileSamples = new Map();

async function readText(file, fallback = '') {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function lines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function run(command, args = [], timeout = 4_000) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ error, output: `${stdout || ''}\n${stderr || ''}` }));
    } catch (error) {
      resolve({ error, output: '' });
    }
  });
}

async function getProcesses() {
  const { output } = await run('ps', ['-axo', 'command'], 3_000);
  return output;
}

function parseRipProcesses(psOutput) {
  const rips = new Map();
  for (const line of psOutput.split(/\r?\n/)) {
    if (!line.includes('makemkvcon') || !line.includes('staging/tmnt-2012/disc-')) continue;
    const source = line.match(/\bmkv\s+disc:(\d+)\s+\d+\s+/);
    const target = line.match(/staging\/tmnt-2012\/disc-(\d+)(?:\/)?(?:\s|$)/);
    if (target) {
      rips.set(Number(target[1]), {
        drive: source ? Number(source[1]) + 1 : null,
      });
    }
  }
  return rips;
}

async function listStagingDiscs() {
  try {
    const entries = await fs.promises.readdir(STAGING_ROOT, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^disc-\d+$/.test(entry.name))
      .map((entry) => Number(entry.name.slice(5)));
  } catch {
    return [];
  }
}

async function getMkvFiles(disc) {
  const dir = path.join(STAGING_ROOT, `disc-${String(disc).padStart(2, '0')}`);
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mkv'))
    .map(async (entry) => {
      const file = path.join(dir, entry.name);
      try {
        const stat = await fs.promises.stat(file);
        return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }));
  return files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function getActiveRips(psOutput) {
  const processes = parseRipProcesses(psOutput);
  const stagingDiscs = await listStagingDiscs();
  const discNumbers = new Set([...processes.keys()]);

  for (const disc of stagingDiscs) {
    const files = await getMkvFiles(disc);
    if (files.length) discNumbers.add(disc);
  }

  const now = Date.now();
  const results = await Promise.all([...discNumbers].sort((a, b) => a - b).map(async (disc) => {
    const files = await getMkvFiles(disc);
    const newest = files[0] || null;
    const titlesDone = files.filter((file) => now - file.mtimeMs > 30_000).length;
    let bytesPerSec = 0;

    if (newest) {
      const previous = fileSamples.get(newest.file);
      if (previous && now > previous.at && newest.size >= previous.size) {
        bytesPerSec = (newest.size - previous.size) / ((now - previous.at) / 1_000);
      }
      fileSamples.set(newest.file, { at: now, size: newest.size });
    }

    const manifestDisc = DISCS.find((item) => item.disc === disc);
    const process = processes.get(disc);
    return {
      disc,
      titlesTotal: manifestDisc?.entries.length || 0,
      currentTitle: titlesDone + 1,
      titlesDone,
      files: files.map((file) => ({
        name: file.name,
        size: file.size,
        mtime: new Date(file.mtimeMs).toISOString(),
      })),
      currentFileBytes: newest?.size || 0,
      bytesPerSec: Math.round(bytesPerSec),
      currentFileMB: Number(((newest?.size || 0) / 1024 / 1024).toFixed(1)),
      mbPerSec: Number((bytesPerSec / 1024 / 1024).toFixed(1)),
      active: Boolean(process),
      drive: process?.drive ?? null,
    };
  }));

  const liveFiles = new Set();
  for (const disc of discNumbers) {
    for (const file of await getMkvFiles(disc)) liveFiles.add(file.file);
  }
  for (const sampledFile of fileSamples.keys()) {
    if (!liveFiles.has(sampledFile)) fileSamples.delete(sampledFile);
  }
  return results;
}

function parseDrive(drive, output) {
  const vendor = output.match(/Vendor(?:\s+Name)?\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
  const product = output.match(/Product(?:\s+Name)?\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
  const combined = `${vendor} ${product}`.trim();
  let name = combined || `Drive ${drive}`;
  if (/HL-DT-ST/i.test(output)) name = 'LG (slow)';
  if (/Slimtype/i.test(output)) name = 'Gotega';
  const hasMedia = /Type\s*:\s*DVD-ROM/i.test(output) && !/No Media/i.test(output);
  return { drive, name, hasMedia };
}

async function getDrives() {
  if (Date.now() - drivesCache.at < 10_000) return drivesCache.value;
  const outputs = await Promise.all([1, 2].map((drive) => run('drutil', ['status', '-drive', String(drive)], 3_000)));
  const value = outputs.map((result, index) => parseDrive(index + 1, result.output));
  drivesCache = { at: Date.now(), value };
  return value;
}

async function countMkvs(root) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) count += await countMkvs(target);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mkv')) count += 1;
  }
  return count;
}

async function getVoiceLab(psOutput) {
  const queue = path.join(VOICE_ROOT, 'queue');
  const [pendingText, doneText, logText] = await Promise.all([
    readText(path.join(queue, 'pending.txt')),
    readText(path.join(queue, 'done.txt')),
    readText(path.join(queue, 'demucs.log')),
  ]);
  const requested = lines(pendingText);
  const done = lines(doneText);
  const doneSet = new Set(done);
  const pending = requested.filter((item) => !doneSet.has(item));
  const running = psOutput.split(/\r?\n/).some((line) => /(^|[\/\s])demucs(?:[\s.]|$)/i.test(line));
  const logLines = lines(logText);
  return {
    running,
    doneCount: done.length,
    pendingCount: pending.length,
    pending,
    current: running ? logLines.at(-1) || null : null,
  };
}

async function getTranscription(psOutput) {
  const failedText = await readText(path.join(VOICE_ROOT, 'queue', 'whisperx-failed.txt'));
  const failedSet = new Set(lines(failedText));
  // Any top-level collection dir dropped into the voice lab counts
  // (TMNT-2012, MMPR-1993, movies, ...); skip workspace dirs.
  const skipDirs = new Set(['queue', 'clips']);
  let topEntries;
  try {
    topEntries = await fs.promises.readdir(VOICE_ROOT, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  const roots = topEntries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skipDirs.has(e.name))
    .map((e) => ({ dir: path.join(VOICE_ROOT, e.name), prefix: e.name }));
  const candidates = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.promises.readdir(root.dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push({
          dir: path.join(root.dir, entry.name),
          relative: `${root.prefix}/${entry.name}`,
        });
      }
    }
  }

  const eligible = (await Promise.all(candidates.map(async (candidate) => {
    try {
      await fs.promises.access(path.join(candidate.dir, 'vocals.flac'));
      return candidate;
    } catch {
      return null;
    }
  }))).filter(Boolean);

  const results = await Promise.all(eligible.map(async (candidate) => {
    try {
      await fs.promises.access(path.join(candidate.dir, 'whisperx.json'));
      return { ...candidate, done: true };
    } catch {
      return { ...candidate, done: false };
    }
  }));
  const done = results.filter((item) => item.done).map((item) => item.relative).sort();
  const failed = results
    .filter((item) => !item.done && failedSet.has(item.relative))
    .map((item) => item.relative)
    .sort();
  const logLines = lines(await readText(path.join(VOICE_ROOT, 'queue', 'whisperx.log')));

  return {
    running: psOutput.split(/\r?\n/).some((line) => /whisperx/i.test(line)),
    current: (logLines.at(-1) || '').slice(0, 160),
    doneCount: done.length,
    eligibleCount: results.length,
    pendingCount: Math.max(0, results.length - done.length - failed.length),
    failedCount: failed.length,
    failed,
    done,
  };
}

async function getRecentEvents() {
  const rawLines = (await readText(path.join(RIPPER_STATE, 'runlog.jsonl'))).split(/\r?\n/);
  const events = [];
  for (let index = rawLines.length - 1; index >= 0 && events.length < 15; index -= 1) {
    if (!rawLines[index].trim()) continue;
    try {
      events.push(JSON.parse(rawLines[index]));
    } catch {
      // A partial final line should not hide older valid events.
    }
  }
  return events.reverse();
}

async function assembleStatus() {
  const psOutput = await getProcesses();
  const [doneObject, activeRips, drives, copyQueue, voiceLab, transcription, recentEvents] = await Promise.all([
    readJson(path.join(RIPPER_STATE, 'discs-done.json'), {}),
    getActiveRips(psOutput),
    getDrives(),
    countMkvs(COPY_ROOT),
    getVoiceLab(psOutput),
    getTranscription(psOutput),
    getRecentEvents(),
  ]);

  const doneNumbers = Object.keys(doneObject)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const doneSet = new Set(doneNumbers);
  const rippingSet = new Set(activeRips.filter((rip) => rip.active).map((rip) => rip.disc));
  const episodesTotal = DISCS.reduce((total, disc) =>
    total + disc.entries.reduce((sum, entry) => sum + entry.codes.length, 0), 0);
  const episodesDone = doneNumbers.reduce((total, discNumber) => {
    const record = doneObject[String(discNumber)] ?? doneObject[discNumber];
    return total + (Array.isArray(record?.eps) ? record.eps.length : 0);
  }, 0);
  const busyDrives = new Set(activeRips.filter((rip) => rip.active && rip.drive).map((rip) => rip.drive));

  return {
    now: new Date().toISOString(),
    series: {
      name: SHOW_NAME,
      episodesTotal,
      episodesDone,
      discsTotal: DISCS.length,
      discsDone: doneNumbers,
    },
    discs: DISCS.map((disc) => {
      const codes = disc.entries.flatMap((entry) => entry.codes);
      return {
        disc: disc.disc,
        eps: codes.length,
        status: doneSet.has(disc.disc) ? 'done' : rippingSet.has(disc.disc) ? 'ripping' : 'pending',
        codes,
      };
    }),
    activeRips,
    drives: drives.map((drive) => ({ ...drive, busy: busyDrives.has(drive.drive) })),
    copyQueue,
    voiceLab,
    transcription,
    recentEvents,
  };
}

async function getStatus() {
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < 2_000) return statusCache.value;
  if (!statusCache.pending) {
    statusCache.pending = assembleStatus()
      .then((value) => {
        statusCache = { at: Date.now(), value, pending: null };
        return value;
      })
      .catch((error) => {
        statusCache.pending = null;
        throw error;
      });
  }
  return statusCache.pending;
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?', 1)[0];
  if (req.method !== 'GET') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n');
    return;
  }

  if (pathname === '/') {
    try {
      send(res, 200, 'text/html; charset=utf-8', await fs.promises.readFile(INDEX_FILE));
    } catch {
      send(res, 500, 'text/plain; charset=utf-8', 'Dashboard page is unavailable\n');
    }
    return;
  }

  if (pathname === '/api/status') {
    try {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await getStatus()));
    } catch (error) {
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
    }
    return;
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
});

server.listen(PORT, HOST, () => {
  console.log(`Rip status dashboard listening on http://${HOST}:${PORT}`);
});
