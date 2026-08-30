import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('state atomicity and locks', () => {
  /** @type {string} */
  let dir;
  /** @type {typeof import('../lib/state.mjs')} */
  let state;

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ripper-state-'));
    process.env.RIPPER_STATE_DIR = dir;
    state = await import('../lib/state.mjs');
  });

  after(async () => {
    delete process.env.RIPPER_STATE_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // reset state file between tests
    await fsp.rm(path.join(dir, 'state.json'), { force: true });
    await fsp.rm(path.join(dir, 'watch.lock'), { force: true });
    await fsp.rm(path.join(dir, 'drive-A.lock'), { force: true });
    await fsp.rm(path.join(dir, 'runlog.jsonl'), { force: true });
  });

  it('loadState returns default when missing', async () => {
    const s = await state.loadState();
    assert.equal(s.drives.A.status, 'EMPTY');
    assert.equal(s.drives.B.status, 'EMPTY');
  });

  it('saveState is atomic tmp+rename and applies mutfn', async () => {
    await state.saveState((s) => {
      s.drives.A = { status: 'RIPPING', folder: '/tmp/x' };
      return s;
    });
    const s = await state.loadState();
    assert.equal(s.drives.A.status, 'RIPPING');
    assert.equal(s.drives.A.folder, '/tmp/x');
    assert.ok(s.updatedAt);

    const entries = await fsp.readdir(dir);
    assert.ok(!entries.some((e) => e.endsWith('.tmp')), 'no leftover tmp files');
  });

  it('acquireWatchLock / release and rejects second live lock', async () => {
    const release = await state.acquireWatchLock();
    await assert.rejects(() => state.acquireWatchLock(), /watch lock held/);
    await release();
    const release2 = await state.acquireWatchLock();
    await release2();
  });

  it('acquireDriveLock is per-drive', async () => {
    const relA = await state.acquireDriveLock('A');
    const relB = await state.acquireDriveLock('B');
    await assert.rejects(() => state.acquireDriveLock('A'), /drive A lock held/);
    await relA();
    const relA2 = await state.acquireDriveLock('A');
    await relA2();
    await relB();
  });

  it('logEvent appends runlog.jsonl', async () => {
    await state.logEvent({ type: 'test', n: 1 });
    await state.logEvent({ type: 'test', n: 2 });
    const text = await fsp.readFile(path.join(dir, 'runlog.jsonl'), 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).n, 1);
    assert.equal(JSON.parse(lines[1]).n, 2);
  });

  it('stale lock (dead pid) can be taken over', async () => {
    await fsp.writeFile(
      path.join(dir, 'watch.lock'),
      JSON.stringify({ pid: 1, start: '2000-01-01T00:00:00.000Z', kind: 'watch' }),
    );
    // pid 1 may or may not be alive on macOS (launchd). Use an impossible pid.
    await fsp.writeFile(
      path.join(dir, 'watch.lock'),
      JSON.stringify({
        pid: 2147483646,
        start: '2000-01-01T00:00:00.000Z',
        kind: 'watch',
      }),
    );
    const release = await state.acquireWatchLock();
    await release();
  });
});
