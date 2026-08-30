#!/usr/bin/env node
/**
 * extras_ocr.mjs — name movie special-features via webcam OCR of the DVD/BD case back.
 *
 * Usage:
 *   node extras_ocr.mjs plan --movie '<folder under .../library/movies/>' [--camera 'HD Pro Webcam C920']
 *   node extras_ocr.mjs match --movie '<folder>' [--titles <path>] [--thumbs]
 *   node extras_ocr.mjs ocr-only [--camera 'HD Pro Webcam C920']
 *
 * Flow (plan):
 *   1. 5s countdown → capture 3 frames (imagesnap, 2s apart) of the case BACK
 *   2. Gemini OCR → JSON { lines: string[] }; auto-save _extras_ocr_titles.json
 *   3. Gemini classify lines → feature titles vs taglines/headers + collection groups
 *   4. ffprobe every file in <movie>/extras/
 *   5. Align title groups → disc-letter file blocks (count + duration sanity)
 *   6. Write _extras_rename_map.txt (high only) + _extras_rename_review.txt (??)
 *
 * Flow (match): skip capture/OCR; load titles JSON; classify + align (+ optional --thumbs).
 *
 * Never renames. Apply with rename_show.sh (creates undo). Low-confidence rows marked ??.
 *
 * Env: GEMINI_API_KEY (required), GEMINI_OCR_MODEL (default gemini-3.1-flash-lite),
 *      RIPPER_CAMERA (default HD Pro Webcam C920). Loads repo .env via ripper/config.mjs.
 *
 * Cost: one classification text call per run; at most one batched vision call with --thumbs.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CAMERA_DEVICE, MEDIA_ROOT, OCR_MODEL } from '../ripper/config.mjs';
import { capture } from '../ripper/lib/camera.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_ROOT = path.join(MEDIA_ROOT, 'library', 'movies');
const MAP_BASENAME = '_extras_rename_map.txt';
const REVIEW_BASENAME = '_extras_rename_review.txt';
const TITLES_BASENAME = '_extras_ocr_titles.json';
const UNDO_BASENAME = '_undo_extras_rename.sh';
const RENAME_SCRIPT = path.join(__dirname, 'rename_show.sh');

/** Duration match within this many seconds → high confidence (printed runtime). */
const DURATION_TOLERANCE_S = 45;
/** Still assign by printed duration up to this delta, but mark ??. */
const DURATION_WEAK_S = 120;

/** Short featurette / web-extra band (seconds). */
const SHORT_BAND = { lo: 2 * 60, hi: 6 * 60 };
/** Making-of / behind-the-scenes band (seconds). */
const LONG_BAND = { lo: 8 * 60, hi: 15 * 60 };

const OCR_PROMPT = `You are reading the BACK of a DVD or Blu-ray case held in front of a webcam.
Extract every text line from the special features / bonus features / extras section
(not the main feature runtime synopsis, not menus).

Return JSON only with this shape:
{ "lines": [ string, ... ] }

Rules:
- Preserve printed order top-to-bottom / left-to-right
- Include feature titles AND section headers / marketing taglines / collection blurbs
  (e.g. "Take a Closer Look at…", "Created for example.com", "Revealing the Secrets Behind…")
- One printed line → one array entry; clean leading bullets/numbers only
- Omit trailers, menus, and the main movie itself
- If multiple frames are provided, use the clearest reading; do not invent lines
- Do NOT invent durations; lines are text only`;

const CLASSIFY_PROMPT = `You classify OCR lines from a DVD/BD case BACK special-features list.

Case backs often mix real featurette titles with marketing taglines and section headers.
Tagline/header examples (NOT feature titles):
- "Revealing the Secrets Behind…"
- "Take a Closer Look at…"
- "Created for lordoftherings.net"
- "8 featurettes created for lordoftherings.net"
- bare section labels like "Appendices", "Documentaries"

Also group consecutive real feature titles that belong to one named collection
(when a header/blurb introduces N shorts, the following N titles share that group).

Return JSON only:
{
  "items": [
    {
      "text": string,          // original line
      "kind": "feature" | "tagline" | "header",
      "groupId": string|null   // shared id for consecutive features in one collection; null if alone
    }
  ],
  "groups": [
    {
      "id": string,
      "label": string,           // human label from the header/blurb
      "expectedCount": number|null  // N if header says "8 featurettes…", else null
    }
  ]
}

Rules:
- items length and order MUST match the input lines exactly (same text, same order)
- kind "feature" = a real named bonus feature / featurette / documentary title
- kind "tagline" | "header" = marketing copy, section headers, collection blurbs (not a file name)
- Only feature items may have a non-null groupId
- Consecutive features under one collection share one groupId; different collections get different ids
- groups[] lists each groupId once with a label; expectedCount from the blurb when present
- Do not invent titles; do not drop or reorder lines`;

const THUMBS_PROMPT = `You are matching video thumbnail frames to candidate special-feature titles.

Each image is labeled IMAGE_<n> and corresponds to FILE_<n> in the file list.
Candidate titles are the only allowed title strings.

Return JSON only:
{
  "assignments": [
    {
      "file": string,           // exact filename from the file list
      "title": string|null,     // best matching candidate title, or null if none fit
      "confidence": "high" | "low"
    }
  ]
}

Rules:
- One assignment per file; use the exact file name strings provided
- title must be an exact candidate string, or null
- Prefer distinctive on-screen title cards / subjects over vague similarity
- confidence "high" only when the frame clearly indicates that title
- Do not invent titles`;

function usage(exitCode = 1) {
  console.error(`Usage:
  node extras_ocr.mjs plan --movie '<folder name>' [--camera 'HD Pro Webcam C920']
  node extras_ocr.mjs match --movie '<folder name>' [--titles <path>] [--thumbs]
  node extras_ocr.mjs ocr-only [--camera 'HD Pro Webcam C920']`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help') usage(cmd ? 0 : 1);
  if (cmd !== 'plan' && cmd !== 'ocr-only' && cmd !== 'match') usage(1);

  let movie = null;
  let camera = null;
  let titles = null;
  let thumbs = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--movie') {
      movie = args[++i];
      if (!movie) usage(1);
    } else if (a === '--camera') {
      camera = args[++i];
      if (!camera) usage(1);
    } else if (a === '--titles') {
      titles = args[++i];
      if (!titles) usage(1);
    } else if (a === '--thumbs') {
      thumbs = true;
    } else if (a === '-h' || a === '--help') {
      usage(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      usage(1);
    }
  }
  if ((cmd === 'plan' || cmd === 'match') && !movie) {
    console.error(`${cmd} requires --movie`);
    usage(1);
  }
  if (cmd !== 'match' && thumbs) {
    console.error('--thumbs is only valid with match');
    usage(1);
  }
  if (cmd !== 'match' && titles) {
    console.error('--titles is only valid with match');
    usage(1);
  }
  return {
    cmd,
    movie,
    titles,
    thumbs,
    camera: camera || process.env.RIPPER_CAMERA?.trim() || CAMERA_DEVICE,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function modelName() {
  return process.env.GEMINI_OCR_MODEL?.trim() || OCR_MODEL;
}

async function run(command, args, { allowNonzero = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowNonzero) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function warnIfMakemkvRunning() {
  try {
    // -x: exact process-name match only — `-f` also matched unrelated processes whose
    // command line merely mentions makemkvcon (e.g. an agent prompt discussing this tool)
    const { code, stdout } = await run('pgrep', ['-xl', 'makemkvcon'], {
      allowNonzero: true,
    });
    if (code === 0 && stdout.trim()) {
      console.warn(
        'WARNING: makemkvcon is running. Webcam is shared with the ripper box scans — wait for tray-idle before capturing.',
      );
      console.warn(stdout.trim().split('\n').slice(0, 3).join('\n'));
    }
  } catch {
    // pgrep missing or failed — ignore
  }
}

async function countdown(seconds = 5) {
  console.log(
    `\nHold the BACK of the DVD/BD case steady in front of the webcam (${seconds}s)…`,
  );
  for (let s = seconds; s >= 1; s--) {
    process.stdout.write(`  ${s}…\r`);
    await sleep(1000);
  }
  process.stdout.write('  capturing…\n');
}

/**
 * Capture 3 frames ~2s apart into tempDir. Returns absolute paths.
 */
async function captureFrames(tempDir, camera) {
  const paths = [];
  for (let i = 0; i < 3; i++) {
    const dest = path.join(tempDir, `frame-${i + 1}.jpg`);
    await capture(dest, { device: camera, warmupS: i === 0 ? 2 : 0.5 });
    paths.push(dest);
    if (i < 2) await sleep(2000);
  }
  return paths;
}

async function loadGenai() {
  const mjs = path.join(
    __dirname,
    '../ripper/node_modules/@google/genai/dist/node/index.mjs',
  );
  return import(pathToFileURL(mjs).href);
}

function requireApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing (set in env or repo .env)');
  return apiKey;
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Gemini response text empty');
  }
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return JSON.parse(raw);
}

async function geminiJson({ prompt, imagePaths = [], schema, label }) {
  const apiKey = requireApiKey();
  const {
    GoogleGenAI,
    Type,
    createPartFromBase64,
    createPartFromText,
  } = await loadGenai();

  // schema may reference Type enums from caller via factory
  const parts = [createPartFromText(prompt)];
  for (const imagePath of imagePaths) {
    const bytes = await fsp.readFile(imagePath);
    const mime = imagePath.toLowerCase().endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
    parts.push(createPartFromBase64(bytes.toString('base64'), mime));
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: modelName(),
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: typeof schema === 'function' ? schema(Type) : schema,
    },
  });

  const text = response.text ?? '';
  try {
    return parseJsonText(text);
  } catch (err) {
    throw new Error(`${label || 'Gemini'} JSON parse failed: ${err.message}`);
  }
}

/**
 * @param {string[]} imagePaths
 * @returns {Promise<string[]>}
 */
async function ocrLines(imagePaths) {
  const parsed = await geminiJson({
    prompt: OCR_PROMPT,
    imagePaths,
    label: 'OCR',
    schema: (Type) => ({
      type: Type.OBJECT,
      properties: {
        lines: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['lines'],
    }),
  });

  const list = Array.isArray(parsed?.lines) ? parsed.lines : null;
  if (!list) throw new Error('OCR payload missing lines array');

  return list.map((line, i) => {
    if (typeof line !== 'string' || !line.trim()) {
      throw new Error(`OCR lines[${i}] empty`);
    }
    return line.trim();
  });
}

/**
 * Classify OCR lines as feature vs tagline/header and group collections.
 * @param {string[]} lines
 * @returns {Promise<{ features: { title: string, groupId: string|null, index: number }[], groups: { id: string, label: string, expectedCount: number|null }[], items: object[] }>}
 */
async function classifyLines(lines) {
  const prompt =
    CLASSIFY_PROMPT +
    '\n\nOCR lines (JSON array, preserve order):\n' +
    JSON.stringify(lines, null, 2);

  const parsed = await geminiJson({
    prompt,
    label: 'classify',
    schema: (Type) => ({
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING },
              kind: {
                type: Type.STRING,
                enum: ['feature', 'tagline', 'header'],
              },
              groupId: { type: Type.STRING, nullable: true },
            },
            required: ['text', 'kind'],
          },
        },
        groups: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              label: { type: Type.STRING },
              expectedCount: { type: Type.NUMBER, nullable: true },
            },
            required: ['id', 'label'],
          },
        },
      },
      required: ['items', 'groups'],
    }),
  });

  const items = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!items) throw new Error('classify payload missing items array');
  if (items.length !== lines.length) {
    throw new Error(
      `classify items length ${items.length} != OCR lines length ${lines.length}`,
    );
  }

  const groupsRaw = Array.isArray(parsed.groups) ? parsed.groups : [];
  /** @type {{ id: string, label: string, expectedCount: number|null }[]} */
  const groups = [];
  const groupById = new Map();
  for (let i = 0; i < groupsRaw.length; i++) {
    const g = groupsRaw[i];
    if (!g || typeof g !== 'object') continue;
    const id = typeof g.id === 'string' ? g.id.trim() : '';
    const label = typeof g.label === 'string' ? g.label.trim() : '';
    if (!id || !label) continue;
    let expectedCount = null;
    if (g.expectedCount != null && g.expectedCount !== '') {
      const n = Number(g.expectedCount);
      if (Number.isFinite(n) && n > 0) expectedCount = Math.round(n);
    }
    const entry = { id, label, expectedCount };
    groups.push(entry);
    groupById.set(id, entry);
  }

  /** @type {{ title: string, groupId: string|null, index: number }[]} */
  const features = [];
  const normalizedItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`classify items[${i}] must be an object`);
    }
    const text =
      typeof item.text === 'string' && item.text.trim()
        ? item.text.trim()
        : lines[i];
    const kind = item.kind;
    if (kind !== 'feature' && kind !== 'tagline' && kind !== 'header') {
      throw new Error(`classify items[${i}].kind invalid: ${kind}`);
    }
    let groupId = null;
    if (item.groupId != null && item.groupId !== '') {
      groupId = String(item.groupId).trim() || null;
    }
    if (kind !== 'feature') groupId = null;
    normalizedItems.push({ text, kind, groupId });
    if (kind === 'feature') {
      features.push({ title: text, groupId, index: features.length });
    }
  }

  return { features, groups, items: normalizedItems, groupById };
}

async function ffprobeDurationS(filePath) {
  const { code, stdout, stderr } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { allowNonzero: true },
  );
  if (code !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${stderr.trim()}`);
  }
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`ffprobe bad duration for ${filePath}: ${stdout.trim()}`);
  }
  return n;
}

/**
 * Parse MakeMKV-style names: A1_t00.mkv / C3_t02.mkv → disc letter + sort key.
 * @returns {{ letter: string|null, key: (number|string)[] }}
 */
function parseTrackName(basename) {
  const m = basename.match(/^([A-Za-z])(\d*)_t(\d+)/i);
  if (m) {
    return {
      letter: m[1].toUpperCase(),
      key: [
        m[1].toUpperCase().charCodeAt(0),
        Number(m[2] || 0),
        Number(m[3]),
      ],
    };
  }
  const t = basename.match(/_t(\d+)/i);
  if (t) return { letter: null, key: [999, 0, Number(t[1])] };
  return { letter: null, key: [1000, 0, basename.toLowerCase()] };
}

function trackSortKey(basename) {
  return parseTrackName(basename).key;
}

function cmpTrack(a, b) {
  const ka = trackSortKey(a);
  const kb = trackSortKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return a.localeCompare(b);
}

/** Sanitize feature title for HFS+/cross-platform filenames. */
function sanitizeTitle(title) {
  let s = String(title).trim();
  s = s.replace(/[:/\\?*|"<>]/g, ' - ');
  s = s.replace(/\s+/g, ' ').replace(/\.+$/, '').trim();
  if (!s) s = 'Untitled Extra';
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

/**
 * Build ordered title groups from classified features.
 * Consecutive same groupId → one group; null/changing id → singleton groups.
 */
function buildTitleGroups(features, groupById) {
  /** @type {{ id: string|null, label: string, titles: { title: string, featureIndex: number }[] }[]} */
  const groups = [];
  for (const feat of features) {
    const last = groups[groups.length - 1];
    if (
      feat.groupId &&
      last &&
      last.id &&
      last.id === feat.groupId
    ) {
      last.titles.push({ title: feat.title, featureIndex: feat.index });
      continue;
    }
    const meta = feat.groupId ? groupById.get(feat.groupId) : null;
    groups.push({
      id: feat.groupId || null,
      label: meta?.label || feat.title,
      expectedCount: meta?.expectedCount ?? null,
      titles: [{ title: feat.title, featureIndex: feat.index }],
    });
  }
  return groups;
}

/**
 * Group track-sorted files into consecutive same disc-letter blocks.
 * @param {{ name: string, duration_s: number, index: number }[]} sortedFiles
 */
function buildFileBlocks(sortedFiles) {
  /** @type {{ letter: string|null, files: typeof sortedFiles }[]} */
  const blocks = [];
  for (const file of sortedFiles) {
    const letter = parseTrackName(file.name).letter;
    const last = blocks[blocks.length - 1];
    if (last && last.letter != null && letter != null && last.letter === letter) {
      last.files.push(file);
      continue;
    }
    blocks.push({ letter, files: [file] });
  }
  return blocks;
}

function durationBandForText(text) {
  const t = String(text || '').toLowerCase();
  if (
    /making[\s-]?of|behind the scenes|documentary|appendices|from the filmmaker/.test(
      t,
    )
  ) {
    return LONG_BAND;
  }
  return SHORT_BAND;
}

function durationBandForGroup(group) {
  const blob = [group.label, ...group.titles.map((t) => t.title)].join(' ');
  return durationBandForText(blob);
}

/** Fraction of files whose duration falls in [lo, hi]. */
function bandFitScore(files, band) {
  if (!files.length) return 0;
  let hits = 0;
  for (const f of files) {
    if (f.duration_s >= band.lo && f.duration_s <= band.hi) hits++;
  }
  return hits / files.length;
}

/**
 * Match classified features to probed files via disc-letter blocks + duration sanity.
 * @returns {{ rows: object[], unmatchedFiles: object[], unmatchedFeatures: object[] }}
 */
function matchTitlesToFiles(features, files, groupById) {
  const usedFiles = new Set();
  const usedFeatures = new Set();
  /** @type {object[]} */
  const rows = [];

  const titleGroups = buildTitleGroups(features, groupById);
  const sortedFiles = files
    .map((f, index) => ({ ...f, index }))
    .sort((a, b) => cmpTrack(a.name, b.name));
  const fileBlocks = buildFileBlocks(sortedFiles);

  // --- Pass 1: exact count block ↔ title-group matches (HIGH) ---
  /** @type {{ gi: number, bi: number, fit: number }[]} */
  const exactPairs = [];
  for (let gi = 0; gi < titleGroups.length; gi++) {
    const tg = titleGroups[gi];
    // Prefer multi-title collections; singletons handled later unless count-locked
    for (let bi = 0; bi < fileBlocks.length; bi++) {
      const block = fileBlocks[bi];
      if (block.files.length !== tg.titles.length) continue;
      if (tg.expectedCount != null && tg.expectedCount !== tg.titles.length) {
        // header count disagrees with classified members — still allow exact file match
      }
      const fit = bandFitScore(block.files, durationBandForGroup(tg));
      exactPairs.push({ gi, bi, fit, size: tg.titles.length });
    }
  }
  // Larger blocks first, then better duration fit
  exactPairs.sort((a, b) => b.size - a.size || b.fit - a.fit);

  const usedGroups = new Set();
  const usedBlocks = new Set();
  for (const pair of exactPairs) {
    if (usedGroups.has(pair.gi) || usedBlocks.has(pair.bi)) continue;
    // Singletons: only lock as HIGH via exact count when duration fit is strong
    // or the group is an explicit multi-collection (size >= 2).
    if (pair.size === 1 && pair.fit < 0.5) continue;

    usedGroups.add(pair.gi);
    usedBlocks.add(pair.bi);
    const tg = titleGroups[pair.gi];
    const block = fileBlocks[pair.bi];
    for (let i = 0; i < tg.titles.length; i++) {
      const feat = tg.titles[i];
      const file = block.files[i];
      usedFeatures.add(feat.featureIndex);
      usedFiles.add(file.index);
      rows.push({
        file: file.name,
        duration_s: file.duration_s,
        title: feat.title,
        confidence: 'high',
        method: pair.size >= 2 ? 'block-count' : 'block-count-single',
        delta_s: null,
        groupId: tg.id,
      });
    }
  }

  // --- Pass 2: printed duration (rare on case backs; keep for when OCR had mins) ---
  // Features may carry durationMinutes if loaded from an enriched titles file.
  const withDur = features
    .map((f, i) => ({ ...f, index: i }))
    .filter(
      (f) =>
        !usedFeatures.has(f.index) &&
        f.durationMinutes != null &&
        Number.isFinite(f.durationMinutes),
    );
  const durCandidates = [];
  for (const feat of withDur) {
    const targetS = feat.durationMinutes * 60;
    for (let fi = 0; fi < files.length; fi++) {
      if (usedFiles.has(fi)) continue;
      const file = files[fi];
      const delta = Math.abs(file.duration_s - targetS);
      if (delta <= DURATION_WEAK_S) {
        durCandidates.push({ featIndex: feat.index, fileIndex: fi, delta });
      }
    }
  }
  durCandidates.sort((a, b) => a.delta - b.delta);
  for (const c of durCandidates) {
    if (usedFeatures.has(c.featIndex) || usedFiles.has(c.fileIndex)) continue;
    usedFeatures.add(c.featIndex);
    usedFiles.add(c.fileIndex);
    const feat = features[c.featIndex];
    const file = files[c.fileIndex];
    rows.push({
      file: file.name,
      duration_s: file.duration_s,
      title: feat.title,
      confidence: c.delta <= DURATION_TOLERANCE_S ? 'high' : '??',
      method: 'duration',
      delta_s: c.delta,
      groupId: feat.groupId,
    });
  }

  // --- Pass 3: remaining title groups ↔ remaining file blocks by order + duration tiebreak ---
  const remainingGroups = titleGroups
    .map((g, gi) => ({ g, gi }))
    .filter(({ gi }) => !usedGroups.has(gi));
  const remainingBlocks = fileBlocks
    .map((b, bi) => ({ b, bi }))
    .filter(({ bi }) => !usedBlocks.has(bi));

  // Greedy: for each remaining multi-group, pick best-fit unused block of equal size
  for (const { g: tg, gi } of remainingGroups.filter(
    ({ g }) => g.titles.length >= 2,
  )) {
    const band = durationBandForGroup(tg);
    let best = null;
    for (const { b: block, bi } of remainingBlocks) {
      if (usedBlocks.has(bi)) continue;
      if (block.files.length !== tg.titles.length) continue;
      const fit = bandFitScore(block.files, band);
      if (!best || fit > best.fit) best = { bi, block, fit };
    }
    if (!best) continue;
    usedGroups.add(gi);
    usedBlocks.add(best.bi);
    for (let i = 0; i < tg.titles.length; i++) {
      const feat = tg.titles[i];
      const file = best.block.files[i];
      if (usedFeatures.has(feat.featureIndex) || usedFiles.has(file.index)) {
        continue;
      }
      usedFeatures.add(feat.featureIndex);
      usedFiles.add(file.index);
      const inBand =
        file.duration_s >= band.lo && file.duration_s <= band.hi;
      rows.push({
        file: file.name,
        duration_s: file.duration_s,
        title: feat.title,
        confidence: best.fit >= 0.75 && inBand ? 'high' : '??',
        method: 'block-order',
        delta_s: null,
        groupId: tg.id,
      });
    }
  }

  // --- Pass 4: zipper remaining features ↔ remaining files (track order), duration keyword boost ---
  const remainingFeats = features
    .map((f, i) => ({ ...f, index: i }))
    .filter((f) => !usedFeatures.has(f.index));
  const remainingFiles = files
    .map((f, i) => ({ ...f, index: i }))
    .filter((f) => !usedFiles.has(f.index))
    .sort((a, b) => cmpTrack(a.name, b.name));

  const n = Math.min(remainingFeats.length, remainingFiles.length);
  for (let i = 0; i < n; i++) {
    const feat = remainingFeats[i];
    const file = remainingFiles[i];
    usedFeatures.add(feat.index);
    usedFiles.add(file.index);
    const band = durationBandForText(feat.title);
    const inBand =
      file.duration_s >= band.lo && file.duration_s <= band.hi;
    rows.push({
      file: file.name,
      duration_s: file.duration_s,
      title: feat.title,
      confidence: '??',
      method: inBand ? 'order+duration' : 'order',
      delta_s: null,
      groupId: feat.groupId,
    });
  }

  rows.sort((a, b) => cmpTrack(a.file, b.file));

  const unmatchedFiles = files
    .filter((_, i) => !usedFiles.has(i))
    .map((f) => ({ file: f.name, duration_s: f.duration_s }));
  const unmatchedFeatures = features
    .filter((_, i) => !usedFeatures.has(i))
    .map((f) => ({
      title: f.title,
      durationMinutes: f.durationMinutes ?? null,
      groupId: f.groupId,
    }));

  return { rows, unmatchedFiles, unmatchedFeatures };
}

/**
 * Extract one frame at 90s per file; one batched Gemini vision call; merge agreement → high.
 * @param {string} extrasDir
 * @param {object[]} rows
 * @param {{ title: string }[]} features
 * @returns {Promise<object[]>}
 */
async function applyThumbsVision(extrasDir, rows, features) {
  const candidates = features.map((f) => f.title);
  if (!candidates.length || !rows.length) return rows;

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'extras-thumbs-'));
  try {
    const frameMeta = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const src = path.join(extrasDir, row.file);
      const dest = path.join(tempDir, `thumb-${i}.jpg`);
      // Seek to 90s; if file shorter, ffmpeg still emits near EOF / last frames.
      const { code, stderr } = await run(
        'ffmpeg',
        [
          '-y',
          '-ss',
          '90',
          '-i',
          src,
          '-frames:v',
          '1',
          '-q:v',
          '3',
          dest,
        ],
        { allowNonzero: true },
      );
      if (code !== 0) {
        console.warn(
          `  thumb skip ${row.file}: ${stderr.trim().split('\n').pop() || 'ffmpeg failed'}`,
        );
        continue;
      }
      try {
        await fsp.access(dest);
      } catch {
        console.warn(`  thumb missing for ${row.file}`);
        continue;
      }
      frameMeta.push({ rowIndex: i, file: row.file, path: dest, imageIndex: frameMeta.length });
    }

    if (!frameMeta.length) {
      console.warn('No thumbnails extracted; skipping vision pass.');
      return rows;
    }

    const fileList = frameMeta
      .map((m, n) => `FILE_${n}: ${m.file}  (IMAGE_${n})`)
      .join('\n');
    const prompt =
      THUMBS_PROMPT +
      `\n\nFiles:\n${fileList}\n\nCandidate titles:\n` +
      JSON.stringify(candidates, null, 2);

    console.log(
      `Vision thumbs: ${frameMeta.length} frame(s) + ${candidates.length} title(s) in one call…`,
    );
    const parsed = await geminiJson({
      prompt,
      imagePaths: frameMeta.map((m) => m.path),
      label: 'thumbs',
      schema: (Type) => ({
        type: Type.OBJECT,
        properties: {
          assignments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                file: { type: Type.STRING },
                title: { type: Type.STRING, nullable: true },
                confidence: {
                  type: Type.STRING,
                  enum: ['high', 'low'],
                },
              },
              required: ['file', 'confidence'],
            },
          },
        },
        required: ['assignments'],
      }),
    });

    const assignments = Array.isArray(parsed?.assignments)
      ? parsed.assignments
      : [];
    const byFile = new Map();
    for (const a of assignments) {
      if (!a || typeof a !== 'object') continue;
      const file = typeof a.file === 'string' ? a.file : '';
      if (!file) continue;
      byFile.set(file, {
        title:
          a.title == null || a.title === ''
            ? null
            : String(a.title).trim(),
        confidence: a.confidence === 'high' ? 'high' : 'low',
      });
    }

    return rows.map((row) => {
      const vision = byFile.get(row.file);
      if (!vision || !vision.title) return row;
      const titlesEqual =
        vision.title.toLowerCase() === String(row.title).toLowerCase();
      if (titlesEqual && vision.confidence === 'high') {
        // Agreement with order/duration/block evidence → promote to high
        return {
          ...row,
          confidence: 'high',
          method: `${row.method}+thumbs`,
        };
      }
      if (!titlesEqual && row.confidence === '??' && vision.confidence === 'high') {
        // Vision-only strong signal on weak rows: keep ?? but record suggestion in method
        return {
          ...row,
          method: `${row.method}|thumbs→${vision.title}`,
        };
      }
      return row;
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function printPlanTable(rows, unmatchedFiles) {
  const col = {
    file: 22,
    dur: 8,
    title: 40,
    conf: 6,
  };
  const hdr =
    `${'file'.padEnd(col.file)}  ${'duration'.padEnd(col.dur)}  ${'proposed title'.padEnd(col.title)}  confidence`;
  console.log('\n' + hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of rows) {
    const mark = r.confidence === '??' ? '??' : r.confidence;
    const title = r.confidence === '??' ? `?? ${r.title}` : r.title;
    console.log(
      `${r.file.padEnd(col.file)}  ${formatDuration(r.duration_s).padEnd(col.dur)}  ${title.slice(0, col.title).padEnd(col.title)}  ${mark}`,
    );
  }
  for (const u of unmatchedFiles) {
    const unmatchedTitle = u.title
      ? `(unmatched) ?? ${u.title}`
      : '(unmatched)';
    console.log(
      `${u.file.padEnd(col.file)}  ${formatDuration(u.duration_s).padEnd(col.dur)}  ${unmatchedTitle.slice(0, col.title).padEnd(col.title)}  ??`,
    );
  }
}

async function writeTitlesFile(movieDir, lines) {
  const titlesPath = path.join(movieDir, TITLES_BASENAME);
  const payload = { lines };
  await fsp.writeFile(titlesPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return titlesPath;
}

/**
 * Load {lines:[...]} titles file. Also accepts legacy {features:[{title}]} by mapping to lines.
 */
async function loadTitlesFile(titlesPath) {
  const raw = await fsp.readFile(titlesPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid titles JSON at ${titlesPath}: ${err.message}`);
  }
  if (Array.isArray(parsed?.lines)) {
    const lines = parsed.lines.map((line, i) => {
      if (typeof line !== 'string' || !line.trim()) {
        throw new Error(`titles.lines[${i}] empty`);
      }
      return line.trim();
    });
    return lines;
  }
  if (Array.isArray(parsed?.features)) {
    return parsed.features.map((f, i) => {
      const title = typeof f?.title === 'string' ? f.title.trim() : '';
      if (!title) throw new Error(`titles.features[${i}].title empty`);
      return title;
    });
  }
  throw new Error(`titles file must have {lines:[...]}: ${titlesPath}`);
}

async function writeMapfile(movieDir, rows) {
  const mapPath = path.join(movieDir, MAP_BASENAME);
  const lines = [];
  const usedTargets = new Set();
  for (const r of rows.filter((row) => row.confidence === 'high')) {
    let base = sanitizeTitle(r.title);
    let targetName = `${base}.mkv`;
    let n = 2;
    while (usedTargets.has(targetName.toLowerCase())) {
      targetName = `${base} (${n}).mkv`;
      n++;
    }
    usedTargets.add(targetName.toLowerCase());
    const src = path.join('extras', r.file);
    const dst = path.join('extras', targetName);
    lines.push(`${src}|${dst}`);
  }
  await fsp.writeFile(mapPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return mapPath;
}

async function writeReviewFile(movieDir, rows) {
  const reviewPath = path.join(movieDir, REVIEW_BASENAME);
  const weakRows = rows.filter((row) => row.confidence === '??');
  const lines = weakRows.map((row) =>
    `${row.file}|${sanitizeTitle(row.title)}.mkv|${row.method}${row.delta_s == null ? '' : `|delta_s=${Math.round(row.delta_s)}`}`,
  );
  await fsp.writeFile(reviewPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return reviewPath;
}

async function resolveMovieExtras(movieName) {
  const movieDir = path.join(MOVIES_ROOT, movieName);
  const extrasDir = path.join(movieDir, 'extras');

  let st;
  try {
    st = await fsp.stat(movieDir);
  } catch {
    throw new Error(`Movie folder not found: ${movieDir}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${movieDir}`);

  let extrasStat;
  try {
    extrasStat = await fsp.stat(extrasDir);
  } catch {
    throw new Error(`No extras/ folder at ${extrasDir}`);
  }
  if (!extrasStat.isDirectory()) {
    throw new Error(`extras is not a directory: ${extrasDir}`);
  }

  const names = (await fsp.readdir(extrasDir)).filter((n) =>
    /\.(mkv|mp4|m4v|avi)$/i.test(n),
  );
  if (!names.length) throw new Error(`No video files in ${extrasDir}`);

  return { movieDir, extrasDir, names };
}

async function probeExtrasFiles(extrasDir, names) {
  console.log(`\nffprobe ${names.length} file(s) in extras/…`);
  const files = [];
  for (const name of names) {
    const duration_s = await ffprobeDurationS(path.join(extrasDir, name));
    files.push({ name, duration_s });
  }
  return files;
}

/**
 * Shared classify → match → write outputs path used by plan and match.
 */
async function runMatchPipeline({
  movieDir,
  extrasDir,
  names,
  lines,
  thumbs,
}) {
  console.log(`Classify ${lines.length} OCR line(s) via ${modelName()}…`);
  const { features, groups, items, groupById } = await classifyLines(lines);

  const featureCount = features.length;
  const skipped = items.filter((i) => i.kind !== 'feature').length;
  console.log(
    `  → ${featureCount} feature title(s), ${skipped} tagline/header(s), ${groups.length} group(s)`,
  );
  for (const g of groups) {
    const n =
      g.expectedCount != null
        ? ` (expected ${g.expectedCount})`
        : '';
    console.log(`  group ${g.id}: ${g.label}${n}`);
  }
  for (const f of features) {
    const g = f.groupId ? ` [${f.groupId}]` : '';
    console.log(`  - ${f.title}${g}`);
  }

  const files = await probeExtrasFiles(extrasDir, names);
  let { rows, unmatchedFiles, unmatchedFeatures } = matchTitlesToFiles(
    features,
    files,
    groupById,
  );

  if (thumbs) {
    console.log('\n--thumbs: extracting frames at 90s…');
    rows = await applyThumbsVision(extrasDir, rows, features);
  }

  const highRows = rows.filter((row) => row.confidence === 'high');
  const reviewRows = rows.filter((row) => row.confidence === '??');
  printPlanTable(
    highRows,
    unmatchedFiles.concat(
      reviewRows.map((row) => ({
        file: row.file,
        duration_s: row.duration_s,
        title: row.title,
      })),
    ),
  );
  if (unmatchedFeatures.length) {
    console.log('\nUnmatched OCR titles:');
    for (const f of unmatchedFeatures) {
      console.log(`  - ${f.title}`);
    }
  }

  const mapPath = await writeMapfile(movieDir, highRows);
  const reviewPath = await writeReviewFile(movieDir, reviewRows);
  console.log(`\nWrote mapfile: ${mapPath}`);
  console.log(`Wrote unmatched review file: ${reviewPath}`);

  const undoPath = path.join(movieDir, UNDO_BASENAME);
  console.log(
    `\nTo apply (creates undo):\n  ${RENAME_SCRIPT} ${JSON.stringify(movieDir)} ${JSON.stringify(mapPath)} ${JSON.stringify(undoPath)} apply`,
  );

  return { highRows, reviewRows };
}

async function cmdOcrOnly(camera) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'extras-ocr-'));
  try {
    await countdown(5);
    console.log(`Capturing 3 frames with "${camera}"…`);
    const frames = await captureFrames(tempDir, camera);
    console.log(`OCR via ${modelName()}…`);
    const lines = await ocrLines(frames);
    console.log(JSON.stringify({ lines }, null, 2));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdPlan(movieName, camera) {
  const { movieDir, extrasDir, names } = await resolveMovieExtras(movieName);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'extras-ocr-'));
  try {
    await countdown(5);
    console.log(`Capturing 3 frames with "${camera}"…`);
    const frames = await captureFrames(tempDir, camera);

    console.log(`OCR via ${modelName()}…`);
    const lines = await ocrLines(frames);
    console.log(`OCR found ${lines.length} line(s):`);
    for (const line of lines) console.log(`  - ${line}`);

    const titlesPath = await writeTitlesFile(movieDir, lines);
    console.log(`Saved titles: ${titlesPath}`);

    await runMatchPipeline({
      movieDir,
      extrasDir,
      names,
      lines,
      thumbs: false,
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdMatch(movieName, titlesPathArg, thumbs) {
  const { movieDir, extrasDir, names } = await resolveMovieExtras(movieName);
  const titlesPath = titlesPathArg
    ? path.isAbsolute(titlesPathArg)
      ? titlesPathArg
      : path.resolve(process.cwd(), titlesPathArg)
    : path.join(movieDir, TITLES_BASENAME);

  console.log(`Loading titles from ${titlesPath}…`);
  const lines = await loadTitlesFile(titlesPath);
  console.log(`Loaded ${lines.length} line(s) (no capture/OCR).`);

  await runMatchPipeline({
    movieDir,
    extrasDir,
    names,
    lines,
    thumbs,
  });
}

async function main() {
  const { cmd, movie, camera, titles, thumbs } = parseArgs(process.argv);
  await warnIfMakemkvRunning();

  if (cmd === 'ocr-only') {
    await cmdOcrOnly(camera);
  } else if (cmd === 'match') {
    await cmdMatch(movie, titles, thumbs);
  } else {
    await cmdPlan(movie, camera);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
