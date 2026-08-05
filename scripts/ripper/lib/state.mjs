import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR as DEFAULT_STATE_DIR } from '../config.mjs';

function stateDir() {
  return process.env.RIPPER_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
}

function statePath() {
  return path.join(stateDir(), 'state.json');
}

function runlogPath() {
  return path.join(stateDir(), 'runlog.jsonl');
}

function watchLockPath() {
  return path.join(stateDir(), 'watch.lock');
}

function driveLockPath(drive) {
  return path.join(stateDir(), `drive-${String(drive).toUpperCase()}.lock`);
}

async function ensureDir() {
  await fsp.mkdir(stateDir(), { recursive: true });
}

function defaultState() {
  return {
    version: 1,
    drives: {
      A: { status: 'EMPTY' },
      B: { status: 'EMPTY' },
    },
    updatedAt: null,
  };
}

/**
 * @returns {Promise<object>}
 */
export async function loadState() {
  await ensureDir();
  const p = statePath();
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState();
    throw err;
  }
}

/**
 * Atomically mutate+write state via tmp+rename.
 * @param {(state: object) => object | Promise<object>} mutfn
 * @returns {Promise<object>}
 */
export async function saveState(mutfn) {
  await ensureDir();
  const current = await loadState();
  const next = await mutfn(structuredClone(current));
  next.updatedAt = new Date().toISOString();
  const p = statePath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(next, null, 2)}\n`;
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, p);
  return next;
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(lockPath) {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isStale(lock) {
  if (!lock) return true;
  return !pidAlive(lock.pid);
}

/**
 * Acquire exclusive watch lock (pid + start). Throws if held by live process.
 * @returns {Promise<() => Promise<void>>} release function
 */
export async function acquireWatchLock() {
  await ensureDir();
  const lockPath = watchLockPath();
  const existing = await readLock(lockPath);
  if (existing && !isStale(existing)) {
    throw new Error(
      `watch lock held by pid ${existing.pid} (started ${existing.start})`,
    );
  }
  if (existing) {
    try {
      await fsp.unlink(lockPath);
    } catch {
      /* ignore */
    }
  }
  const lock = {
    pid: process.pid,
    start: new Date().toISOString(),
    kind: 'watch',
  };
  const tmp = `${lockPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(lock)}\n`, 'utf8');
  try {
    await fsp.rename(tmp, lockPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    // race: another writer won
    const again = await readLock(lockPath);
    if (again && !isStale(again) && again.pid !== process.pid) {
      throw new Error(
        `watch lock held by pid ${again.pid} (started ${again.start})`,
      );
    }
    throw err;
  }
  return async () => {
    try {
      const cur = await readLock(lockPath);
      if (cur?.pid === process.pid) await fsp.unlink(lockPath);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Per-drive op lock shared by manual rip and watch.
 * @param {string} drive 'A' | 'B'
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireDriveLock(drive) {
  await ensureDir();
  const id = String(drive).toUpperCase();
  const lockPath = driveLockPath(id);
  const existing = await readLock(lockPath);
  if (existing && !isStale(existing)) {
    throw new Error(
      `drive ${id} lock held by pid ${existing.pid} (started ${existing.start})`,
    );
  }
  if (existing) {
    try {
      await fsp.unlink(lockPath);
    } catch {
      /* ignore */
    }
  }
  const lock = {
    pid: process.pid,
    start: new Date().toISOString(),
    kind: 'drive',
    drive: id,
  };
  const tmp = `${lockPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(lock)}\n`, 'utf8');
  try {
    await fsp.rename(tmp, lockPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    const again = await readLock(lockPath);
    if (again && !isStale(again) && again.pid !== process.pid) {
      throw new Error(
        `drive ${id} lock held by pid ${again.pid} (started ${again.start})`,
      );
    }
    throw err;
  }
  return async () => {
    try {
      const cur = await readLock(lockPath);
      if (cur?.pid === process.pid) await fsp.unlink(lockPath);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Append one JSON line to runlog.jsonl.
 * @param {object} obj
 */
export async function logEvent(obj) {
  await ensureDir();
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`;
  await fsp.appendFile(runlogPath(), line, 'utf8');
}

/** Test helper: expose resolved paths. */
export function _paths() {
  return {
    stateDir: stateDir(),
    statePath: statePath(),
    runlogPath: runlogPath(),
    watchLockPath: watchLockPath(),
  };
}

/** Sync existence check used by doctor. */
export function stateDirExistsSync() {
  return fs.existsSync(stateDir());
}
