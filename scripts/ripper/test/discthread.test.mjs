import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('DiscThread slack lifecycle', () => {
  /** @type {typeof import('../lib/discthread.mjs')} */
  let disc;
  /** @type {Array<{url: string, body: object}>} */
  let calls;
  /** @type {typeof fetch} */
  let origFetch;
  let tsCounter;

  beforeEach(async () => {
    calls = [];
    tsCounter = 0;
    origFetch = globalThis.fetch;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C123';

    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const method = String(url).split('/').pop();
      if (method === 'chat.postMessage') {
        tsCounter += 1;
        return {
          ok: true,
          async json() {
            return { ok: true, ts: `ts-${tsCounter}` };
          },
        };
      }
      if (method === 'chat.update' || method === 'reactions.add' || method === 'reactions.remove') {
        return {
          ok: true,
          async json() {
            return { ok: true };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { ok: true };
        },
      };
    };

    // Fresh module each time so it picks up our fetch (slack uses global fetch)
    disc = await import(`../lib/discthread.mjs?t=${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL_ID;
  });

  function byMethod(name) {
    return calls.filter((c) => c.url.endsWith(`/${name}`));
  }

  it('start posts root + hourglass; step edits root; milestone replies without broadcast', async () => {
    const thread = await disc.DiscThread.start({
      driveId: 'A',
      discLabel: 'TMNT vol 14',
      volTitle: null,
    });
    assert.ok(disc.isLiveThread(thread));
    assert.equal(thread.ts, 'ts-1');

    const posts = byMethod('chat.postMessage');
    assert.equal(posts.length, 1);
    assert.match(posts[0].body.text, /🎬 Drive A — TMNT vol 14 — step 1\/6 box scan/);
    assert.equal(posts[0].body.channel, 'C123');
    assert.equal(posts[0].body.thread_ts, undefined);

    const reacts = byMethod('reactions.add');
    assert.equal(reacts.length, 1);
    assert.equal(reacts[0].body.name, 'hourglass_flowing_sand');
    assert.equal(reacts[0].body.timestamp, 'ts-1');

    await thread.step(2, 'disc analyze', { volTitle: 'City at War' });
    const updates = byMethod('chat.update');
    assert.equal(updates.length, 1);
    assert.match(
      updates[0].body.text,
      /🎬 Drive A — TMNT vol 14 «City at War» — step 2\/6 disc analyze/,
    );
    assert.equal(updates[0].body.ts, 'ts-1');

    await thread.milestone('disc analyze: mode=playall, titles=1');
    const replies = byMethod('chat.postMessage').slice(1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].body.thread_ts, 'ts-1');
    assert.equal(replies[0].body.reply_broadcast, undefined);
    assert.match(replies[0].body.text, /mode=playall/);
  });

  it('success swaps hourglass→check and broadcast-replies', async () => {
    const thread = await disc.DiscThread.start({
      driveId: 'B',
      discLabel: 'TMNT vol 1',
      volTitle: 'Things Change',
    });
    await thread.step(6, 'verify+eject');
    await thread.success('✅ Drive B done');

    const removes = byMethod('reactions.remove');
    assert.ok(removes.some((r) => r.body.name === 'hourglass_flowing_sand'));

    const adds = byMethod('reactions.add');
    assert.ok(adds.some((r) => r.body.name === 'white_check_mark'));

    const broadcasts = byMethod('chat.postMessage').filter((c) => c.body.reply_broadcast === true);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].body.thread_ts, 'ts-1');
    assert.match(broadcasts[0].body.text, /Drive B done/);
  });

  it('fail swaps hourglass→x and broadcast-replies', async () => {
    const thread = await disc.DiscThread.start({
      driveId: 'A',
      discLabel: 'TMNT vol 7',
    });
    await thread.fail('❌ Drive A FAILED_SEATED: boom');

    const removes = byMethod('reactions.remove');
    assert.ok(removes.some((r) => r.body.name === 'hourglass_flowing_sand'));

    const adds = byMethod('reactions.add');
    assert.ok(adds.some((r) => r.body.name === 'x'));

    const broadcasts = byMethod('chat.postMessage').filter((c) => c.body.reply_broadcast === true);
    assert.equal(broadcasts.length, 1);
    assert.match(broadcasts[0].body.text, /FAILED_SEATED/);
  });

  it('no-ops cleanly when Slack env is absent', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL_ID;
    const before = calls.length;

    const thread = await disc.DiscThread.start({
      driveId: 'A',
      discLabel: 'TMNT vol 1',
    });
    assert.equal(disc.isLiveThread(thread), false);

    await thread.step(3, 'ripping episodes');
    await thread.milestone('hi');
    await thread.success('done');
    await thread.fail('err');

    assert.equal(calls.length, before, 'no fetch calls without env');
  });

  it('formatRoot matches owner example shape', () => {
    assert.equal(
      disc.formatRoot({
        driveId: 'A',
        discLabel: 'TMNT vol 14',
        volTitle: 'City at War',
        stepN: 1,
        stepLabel: 'box scan',
      }),
      '🎬 Drive A — TMNT vol 14 «City at War» — step 1/6 box scan',
    );
  });
});

describe('slack helpers missing_scope silent degrade', () => {
  /** @type {typeof import('../lib/slack.mjs')} */
  let slack;
  /** @type {typeof fetch} */
  let origFetch;
  /** @type {string[]} */
  let warns;

  beforeEach(async () => {
    origFetch = globalThis.fetch;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C123';
    warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => {
      warns.push(args.map(String).join(' '));
      origWarn(...args);
    };
    // stash restore
    console.warn._orig = origWarn;

    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { ok: false, error: 'missing_scope' };
      },
    });
    slack = await import(`../lib/slack.mjs?t=${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (console.warn._orig) console.warn = console.warn._orig;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL_ID;
  });

  it('react/unreact do not warn on missing_scope', async () => {
    await slack.react('ts-1', 'hourglass_flowing_sand');
    await slack.unreact('ts-1', 'hourglass_flowing_sand');
    assert.equal(warns.length, 0);
  });
});
