import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function run(command, args, { allowNonzero = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowNonzero) resolveRun({ code, stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function readChapters(mkvPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', mkvPath]);
  const parsed = JSON.parse(stdout);
  return (parsed.chapters ?? []).map((chapter) => ({
    start_s: Number(chapter.start_time),
    end_s: Number(chapter.end_time),
  }));
}

export function groupChapters(chapters, n) {
  if (!Number.isInteger(n) || n < 1 || n > chapters.length) throw new RangeError('Group count must be between 1 and chapter count');
  const prefix = [0];
  for (const chapter of chapters) prefix.push(prefix.at(-1) + (chapter.end_s - chapter.start_s));
  const target = prefix.at(-1) / n;
  const dp = Array.from({ length: n + 1 }, () => Array(chapters.length + 1).fill(Infinity));
  const previous = Array.from({ length: n + 1 }, () => Array(chapters.length + 1).fill(-1));
  dp[0][0] = 0;
  for (let groups = 1; groups <= n; groups += 1) {
    for (let end = groups; end <= chapters.length - (n - groups); end += 1) {
      for (let start = groups - 1; start < end; start += 1) {
        const duration = prefix[end] - prefix[start];
        const cost = dp[groups - 1][start] + (duration - target) ** 2;
        if (cost < dp[groups][end]) {
          dp[groups][end] = cost;
          previous[groups][end] = start;
        }
      }
    }
  }
  const groups = [];
  let end = chapters.length;
  for (let count = n; count > 0; count -= 1) {
    const start = previous[count][end];
    groups.unshift(Array.from({ length: end - start }, (_, offset) => start + offset));
    end = start;
  }
  return groups;
}

export async function splitAtChapters(mkvPath, groups, destDir, baseName) {
  if (!groups.length || groups.some((group) => !group.length)) throw new Error('Chapter groups must be non-empty');
  await mkdir(destDir, { recursive: true });
  const output = resolve(destDir, `${baseName}.mkv`);
  const splitPoints = groups.slice(1).map((group) => group[0] + 1);
  const before = new Set(await readdir(destDir));
  const args = ['-o', output];
  if (splitPoints.length) args.push('--split', `chapters:${splitPoints.join(',')}`);
  args.push(mkvPath);
  await run('mkvmerge', args);
  const after = await readdir(destDir);
  return after.filter((name) => !before.has(name) && name.toLowerCase().endsWith('.mkv'))
    .sort().map((name) => resolve(destDir, name));
}

export async function verifyRip(file, expected_s, { minBytes = 200 * 1024 * 1024 } = {}) {
  let fileStat;
  try {
    fileStat = await stat(file);
  } catch {
    return { ok: false, duration_s: 0, reason: 'file missing' };
  }
  if (fileStat.size <= minBytes) return { ok: false, duration_s: 0, reason: `file is smaller than ${Math.round(minBytes / 1e6)} MB` };

  const held = await run('lsof', ['--', file], { allowNonzero: true });
  if (held.code === 0 && held.stdout.trim()) return { ok: false, duration_s: 0, reason: 'file is open by another process' };
  const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { allowNonzero: true });
  if (probe.code !== 0 || probe.stderr.trim()) return { ok: false, duration_s: 0, reason: probe.stderr.trim() || 'ffprobe stream check failed' };
  let parsed;
  try { parsed = JSON.parse(probe.stdout); } catch { return { ok: false, duration_s: 0, reason: 'invalid ffprobe output' }; }
  const duration_s = Number(parsed.format?.duration);
  if (!parsed.streams?.length || !Number.isFinite(duration_s)) return { ok: false, duration_s: 0, reason: 'missing streams or duration' };
  if (expected_s != null && Math.abs(duration_s - expected_s) > 120) return { ok: false, duration_s, reason: 'duration differs from expected by more than 2 minutes' };
  return { ok: true, duration_s };
}
