import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseInfoOutput, parseRobotLine } from './robot.mjs';

export const MAKEMKVCON = process.env.MAKEMKVCON
  || '/Applications/MakeMKV.app/Contents/MacOS/makemkvcon';

function run(command, args, { allowNonzero = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 || allowNonzero)
      ? resolveRun({ code, output })
      : reject(new Error(`${command} exited ${code}: ${output.trim()}`)));
  });
}

export async function enumerateDrives() {
  // MakeMKV intentionally exits nonzero after emitting enumeration for disc:9999.
  const { code, output } = await run(MAKEMKVCON, ['-r', 'info', 'disc:9999'], { allowNonzero: true });
  const drives = parseInfoOutput(output).drives;
  if (!drives.length && code !== 0) throw new Error(`makemkvcon enumeration exited ${code}: ${output.trim()}`);
  return drives;
}

export async function resolveDrive(driveNamePrefix) {
  const matches = (await enumerateDrives()).filter((drive) => drive.driveName.startsWith(driveNamePrefix));
  if (matches.length !== 1) throw new Error(`Drive prefix matched ${matches.length} drives: ${driveNamePrefix}`);
  const { index, osDevice, discLabel, mediaPresent } = matches[0];
  return { index, osDevice, discLabel, mediaPresent };
}

export async function scanDisc(index) {
  const { output } = await run(MAKEMKVCON, ['-r', 'info', `disc:${index}`]);
  const parsed = parseInfoOutput(output);
  return { discLabel: parsed.discLabel, titles: parsed.titles };
}

async function mkvSnapshot(destDir) {
  const result = new Map();
  for (const name of await readdir(destDir)) {
    if (!name.toLowerCase().endsWith('.mkv')) continue;
    const info = await stat(resolve(destDir, name));
    result.set(name, `${info.size}:${info.mtimeMs}`);
  }
  return result;
}

export async function ripTitle({ index, titleId, destDir, onProgress }) {
  const before = await mkvSnapshot(destDir);
  return new Promise((resolveRip, reject) => {
    // --progress=-same makes makemkvcon emit PRGV lines (it emits none otherwise);
    // ripper.mjs relies on the first PRGV to release the disc-open gate early.
    const child = spawn(MAKEMKVCON, ['-r', '--progress=-same', 'mkv', `disc:${index}`, String(titleId), destDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const messages = [];
    let pending = '';

    const consume = (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const record = parseRobotLine(line);
        if (record?.type === 'PRGV') onProgress?.(record);
        if (record?.type === 'MSG') {
          messages.push(record.fields[3] || record.fields.join(','));
          if (messages.length > 20) messages.shift();
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', consume);
    child.stderr.setEncoding('utf8').on('data', consume);
    child.on('error', reject);
    child.on('close', async (code) => {
      if (pending) consume('\n');
      if (code !== 0) return reject(new Error(`makemkvcon exited ${code}: ${messages.join(' | ')}`));
      try {
        const after = await mkvSnapshot(destDir);
        const created = [...after].filter(([name, signature]) => before.get(name) !== signature);
        if (created.length !== 1) throw new Error(`Expected one newly created MKV, found ${created.length}`);
        resolveRip({ outFile: resolve(destDir, created[0][0]) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function classifyTitles(titles, expectedEps) {
  const extras = titles.filter((title) => title.duration_s < 15 * 60);
  const long = titles.filter((title) => title.duration_s >= 45 * 60);
  const episodeCount = Number.isInteger(expectedEps) && expectedEps > 0 ? expectedEps : null;
  if (long.length === 1
      && (!episodeCount || long[0].chapters >= episodeCount)
      && titles.every((title) => title.id === long[0].id || title.duration_s < 15 * 60)) {
    return { mode: 'playall', episodeTitleIds: [long[0].id], playallId: long[0].id, extraIds: extras.map((t) => t.id) };
  }

  const candidates = titles.filter((title) => title.duration_s >= 15 * 60 && title.duration_s <= 35 * 60);
  if (candidates.length >= 2) {
    const sum = candidates.reduce((total, title) => total + title.duration_s, 0);
    const playall = titles.find((title) => !candidates.includes(title) && Math.abs(title.duration_s - sum) <= sum * 0.1);
    return { mode: 'per-title', episodeTitleIds: candidates.map((t) => t.id), playallId: playall?.id ?? null, extraIds: extras.map((t) => t.id) };
  }
  return { mode: 'unknown', episodeTitleIds: [], playallId: null, extraIds: extras.map((t) => t.id) };
}

export async function eject(osDevice) {
  const drives = await enumerateDrives();
  const target = drives.find((drive) => drive.osDevice === osDevice);
  if (!target) throw new Error(`Cannot resolve optical device for eject: ${osDevice}`);
  // diskutil targets the exact BSD device; drutil's -drive N numbering does NOT
  // match MakeMKV's DRV ordering (it ejected the other drive in live testing).
  // /dev/rdiskN and /dev/diskN are interchangeable for diskutil.
  const bsd = osDevice.replace('/dev/rdisk', '/dev/disk');
  await run('diskutil', ['eject', bsd]);
  const after = await enumerateDrives();
  if (after.some((drive) => drive.osDevice === osDevice && drive.mediaPresent)) {
    throw new Error(`Eject did not remove media from ${osDevice}`);
  }
}
