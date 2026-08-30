import { spawn } from 'node:child_process';
import { CAMERA_DEVICE, CAMERA_WARMUP_S } from '../config.mjs';

/**
 * Capture a single frame via imagesnap.
 * @param {string} destPath
 * @param {{ device?: string, warmupS?: number }} [opts]
 * @returns {Promise<string>} destPath
 */
export function capture(destPath, opts = {}) {
  const device = opts.device || process.env.RIPPER_CAMERA || CAMERA_DEVICE;
  const warmup = opts.warmupS ?? CAMERA_WARMUP_S;

  return new Promise((resolve, reject) => {
    const args = ['-d', device, '-w', String(warmup), destPath];
    const child = spawn('imagesnap', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`imagesnap failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`imagesnap exited ${code}: ${stderr.trim() || destPath}`));
        return;
      }
      resolve(destPath);
    });
  });
}
