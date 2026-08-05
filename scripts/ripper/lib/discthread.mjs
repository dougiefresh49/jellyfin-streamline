/**
 * One Slack thread per disc: root message edited for step progress,
 * thread replies for milestones / success / fail.
 */
import {
  postMessage,
  updateMessage,
  reply,
  react,
  unreact,
} from './slack.mjs';

export const STEPS = Object.freeze([
  { n: 1, label: 'box scan' },
  { n: 2, label: 'disc analyze' },
  { n: 3, label: 'ripping episodes' },
  { n: 4, label: 'splitting' },
  { n: 5, label: 'extras' },
  { n: 6, label: 'verify+eject' },
]);

const EMOJI_PROGRESS = 'hourglass_flowing_sand';
const EMOJI_OK = 'white_check_mark';
const EMOJI_ERR = 'x';

/**
 * @param {{ driveId: string, discLabel?: string|null, volTitle?: string|null, stepN?: number, stepLabel?: string }} p
 */
export function formatRoot({ driveId, discLabel, volTitle, stepN, stepLabel }) {
  const label = discLabel || 'unknown disc';
  const titlePart = volTitle ? ` «${volTitle}»` : '';
  const stepPart =
    stepN != null && stepLabel
      ? ` — step ${stepN}/6 ${stepLabel}`
      : '';
  return `🎬 Drive ${driveId} — ${label}${titlePart}${stepPart}`;
}

class NullDiscThread {
  async step() {}
  async milestone() {}
  async success() {}
  async fail() {}
}

export class DiscThread {
  /**
   * @param {{ ts: string, driveId: string, discLabel: string|null, volTitle: string|null }} opts
   */
  constructor({ ts, driveId, discLabel, volTitle }) {
    this.ts = ts;
    this.driveId = driveId;
    this.discLabel = discLabel || null;
    this.volTitle = volTitle || null;
    this.stepN = 1;
    this.stepLabel = STEPS[0].label;
  }

  /**
   * Post root message + hourglass. Returns null-object if Slack unavailable.
   * @param {{ driveId: string, discLabel?: string|null, volTitle?: string|null }} opts
   * @returns {Promise<DiscThread|NullDiscThread>}
   */
  static async start({ driveId, discLabel = null, volTitle = null }) {
    const text = formatRoot({
      driveId,
      discLabel,
      volTitle,
      stepN: 1,
      stepLabel: STEPS[0].label,
    });
    const posted = await postMessage(text);
    if (!posted?.ts) return new NullDiscThread();
    const thread = new DiscThread({
      ts: posted.ts,
      driveId,
      discLabel,
      volTitle,
    });
    await react(posted.ts, EMOJI_PROGRESS);
    return thread;
  }

  rootText() {
    return formatRoot({
      driveId: this.driveId,
      discLabel: this.discLabel,
      volTitle: this.volTitle,
      stepN: this.stepN,
      stepLabel: this.stepLabel,
    });
  }

  /**
   * Update root to step n/6. Optionally refresh discLabel/volTitle via opts.
   * @param {number} n
   * @param {string} [label]
   * @param {{ discLabel?: string|null, volTitle?: string|null }} [meta]
   */
  async step(n, label, meta = {}) {
    if (meta.discLabel != null) this.discLabel = meta.discLabel;
    if (meta.volTitle != null) this.volTitle = meta.volTitle;
    const known = STEPS.find((s) => s.n === n);
    this.stepN = n;
    this.stepLabel = label || known?.label || `step ${n}`;
    await updateMessage(this.ts, this.rootText());
  }

  /** Thread reply, no broadcast. */
  async milestone(text) {
    await reply(this.ts, text, { broadcast: false });
  }

  /** Swap hourglass→check, final root edit, broadcast reply. */
  async success(text) {
    await unreact(this.ts, EMOJI_PROGRESS);
    await unreact(this.ts, EMOJI_ERR);
    await react(this.ts, EMOJI_OK);
    await updateMessage(this.ts, this.rootText());
    await reply(this.ts, text, { broadcast: true });
  }

  /** Swap hourglass→x, root edit, broadcast reply. */
  async fail(text) {
    await unreact(this.ts, EMOJI_PROGRESS);
    await unreact(this.ts, EMOJI_OK);
    await react(this.ts, EMOJI_ERR);
    await updateMessage(this.ts, this.rootText());
    await reply(this.ts, text, { broadcast: true });
  }
}

/** @returns {boolean} */
export function isLiveThread(thread) {
  return thread instanceof DiscThread;
}
