import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

/** Drive A name from fixtures/drv-enumeration.txt (serial-ish suffix). */
const DRIVE_A_DEFAULT =
  'DVD+R-DL Slimtype DVD A DS8A4S JL61 007080176998';

export const RIPPER_DIR = __dirname;
export const REPO_ROOT_PATH = REPO_ROOT;

export const DRIVE_A_NAME =
  process.env.RIPPER_DRIVE_A_NAME?.trim() || DRIVE_A_DEFAULT;
/** Unknown until second drive plugged in; override via RIPPER_DRIVE_B_NAME. */
export const DRIVE_B_NAME = process.env.RIPPER_DRIVE_B_NAME?.trim() || '';

/** blue/left = A, red/right = B */
export const SLOTS = {
  blue: {
    slot: 'blue',
    side: 'left',
    drive: 'A',
    driveNamePrefix: DRIVE_A_NAME,
  },
  red: {
    slot: 'red',
    side: 'right',
    drive: 'B',
    driveNamePrefix: DRIVE_B_NAME,
  },
};

export const DRIVES = {
  A: { id: 'A', slot: 'blue', driveNamePrefix: DRIVE_A_NAME },
  B: { id: 'B', slot: 'red', driveNamePrefix: DRIVE_B_NAME },
};

export const STAGING_ROOT =
  process.env.RIPPER_STAGING_ROOT?.trim() ||
  '/Volumes/Seagate 4TB/media/_staging/shows/Teenage Mutant Ninja Turtles (2003)';

export const STATE_DIR =
  process.env.RIPPER_STATE_DIR?.trim() ||
  '/Volumes/Seagate 4TB/media/_staging/.ripper';

export const LIBRARY_SHOW_ROOT =
  process.env.RIPPER_LIBRARY_ROOT?.trim() ||
  '/Volumes/Seagate 4TB/media/library/shows/Teenage Mutant Ninja Turtles (2003)';

export const MEDIA_ROOT =
  process.env.RIPPER_MEDIA_ROOT?.trim() || '/Volumes/Seagate 4TB/media';

export const EPISODES_LIST_PATH = path.join(
  __dirname,
  'data',
  'tmnt-2003-episodes.txt',
);

export const SHOW_NAME = 'Teenage Mutant Ninja Turtles (2003)';

export const CAMERA_DEVICE =
  process.env.RIPPER_CAMERA?.trim() || 'HD Pro Webcam C920';
export const CAMERA_WARMUP_S = 2;

export const OCR_MODEL =
  process.env.GEMINI_OCR_MODEL?.trim() || 'gemini-3.1-flash-lite';

export const RIP_EXTRAS = process.env.RIP_EXTRAS !== '0';

/** Confirm second OCR frame after settle (default on). */
export const CONFIRM_SECOND_FRAME = process.env.RIPPER_CONFIRM_FRAME !== '0';

/** Thresholds from spec v2. */
export const THRESHOLDS = {
  settleMs: 8_000,
  confirmFrameDelayMs: 3_000,
  pollMs: 10_000,
  playallMinS: 45 * 60,
  extraMaxS: 15 * 60,
  episodeMinS: 15 * 60,
  episodeMaxS: 35 * 60,
  verifyDurationToleranceS: 2 * 60,
  splitPieceTolerance: 0.2,
  splitSumToleranceS: 60,
  freeSpaceMultiplier: 2,
  ocrConfidenceMin: 0.6,
  volumeNumberMin: 1,
  volumeNumberMax: 99,
  episodesMin: 1,
  episodesMax: 6,
};

export function slotForDrive(driveId) {
  return driveId === 'B' ? SLOTS.red : SLOTS.blue;
}

export function driveForSlot(slot) {
  const key = String(slot).toLowerCase();
  if (key === 'blue' || key === 'left' || key === 'a') return DRIVES.A;
  if (key === 'red' || key === 'right' || key === 'b') return DRIVES.B;
  throw new Error(`Unknown slot/drive: ${slot}`);
}

export function stagingMounted() {
  return MEDIA_ROOT.startsWith('/Volumes/')
    ? MEDIA_ROOT.split('/').slice(0, 3).join('/')
    : MEDIA_ROOT;
}
