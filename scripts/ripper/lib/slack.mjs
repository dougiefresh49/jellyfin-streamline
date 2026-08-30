/**
 * Best-effort Slack helpers. Never throw; no-op without env.
 */

/**
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function notify(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    if (!token || !channel) {
      console.warn('slack: SLACK_BOT_TOKEN or SLACK_CHANNEL_ID missing; skip notify');
      return;
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      console.warn(
        'slack: chat.postMessage failed',
        body.error || res.status,
      );
    }
  } catch (err) {
    console.warn('slack: notify error', err?.message || err);
  }
}

function credentials() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return null;
  return { token, channel };
}

/**
 * @param {string} method
 * @param {object} payload
 * @param {{ silentErrors?: string[] }} [opts]
 * @returns {Promise<object|null>}
 */
async function slackApi(method, payload, opts = {}) {
  try {
    const creds = credentials();
    if (!creds) return null;
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const err = body.error || String(res.status);
      if (opts.silentErrors?.includes(err)) return null;
      console.warn(`slack: ${method} failed`, err);
      return null;
    }
    return body;
  } catch (err) {
    console.warn(`slack: ${method} error`, err?.message || err);
    return null;
  }
}

/**
 * Post a channel message. Returns {ts} or null.
 * @param {string} text
 * @returns {Promise<{ts: string}|null>}
 */
export async function postMessage(text) {
  const creds = credentials();
  if (!creds) return null;
  const body = await slackApi('chat.postMessage', {
    channel: creds.channel,
    text,
  });
  if (!body?.ts) return null;
  return { ts: body.ts };
}

/**
 * Edit an existing message.
 * @param {string} ts
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function updateMessage(ts, text) {
  const creds = credentials();
  if (!creds || !ts) return;
  await slackApi('chat.update', {
    channel: creds.channel,
    ts,
    text,
  });
}

/**
 * Reply in a thread. Optionally broadcast to channel.
 * @param {string} ts
 * @param {string} text
 * @param {{ broadcast?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function reply(ts, text, opts = {}) {
  const creds = credentials();
  if (!creds || !ts) return;
  const payload = {
    channel: creds.channel,
    text,
    thread_ts: ts,
  };
  if (opts.broadcast) payload.reply_broadcast = true;
  await slackApi('chat.postMessage', payload);
}

/**
 * Add a reaction. Missing reactions:write degrades silently.
 * @param {string} ts
 * @param {string} emoji
 * @returns {Promise<void>}
 */
export async function react(ts, emoji) {
  const creds = credentials();
  if (!creds || !ts || !emoji) return;
  await slackApi(
    'reactions.add',
    { channel: creds.channel, timestamp: ts, name: emoji },
    { silentErrors: ['missing_scope', 'already_reacted'] },
  );
}

/**
 * Remove a reaction. Missing reactions:write degrades silently.
 * @param {string} ts
 * @param {string} emoji
 * @returns {Promise<void>}
 */
export async function unreact(ts, emoji) {
  const creds = credentials();
  if (!creds || !ts || !emoji) return;
  await slackApi(
    'reactions.remove',
    { channel: creds.channel, timestamp: ts, name: emoji },
    { silentErrors: ['missing_scope', 'no_reaction'] },
  );
}
