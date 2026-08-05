import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  GoogleGenAI,
  Type,
  createPartFromBase64,
  createPartFromText,
} from '@google/genai';
import { OCR_MODEL, THRESHOLDS } from '../config.mjs';

export class OcrInvalid extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OcrInvalid';
    if (cause) this.cause = cause;
  }
}

const BOX_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    slot: { type: Type.STRING, enum: ['blue', 'red'] },
    series: { type: Type.STRING },
    volume_number: { type: Type.INTEGER },
    volume_title: { type: Type.STRING },
    episodes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      minItems: THRESHOLDS.episodesMin,
      maxItems: THRESHOLDS.episodesMax,
    },
    confidence: { type: Type.NUMBER },
  },
  required: [
    'slot',
    'series',
    'volume_number',
    'volume_title',
    'episodes',
    'confidence',
  ],
};

export const OCR_RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: BOX_SCHEMA,
};

const SCAN_PROMPT = `You are reading the back of DVD boxes on a shelf photographed by a fixed webcam.

Slot convention (physical stickers on the shelf):
- BLUE sticker = LEFT shelf slot → slot value "blue"
- RED sticker = RIGHT shelf slot → slot value "red"

Return a JSON array (0–2 objects). One object per box that is clearly present and legible.
Each object MUST use exactly these fields:
- slot: "blue" or "red"
- series: series name string
- volume_number: integer 1–99 (the printed volume / disc number on the box)
- volume_title: short volume title if printed, else empty string
- episodes: array of 1–6 nonempty episode title strings in printed order (do NOT include "DVD EXTRAS", menus, or bonus feature titles)
- confidence: number from 0 to 1 for this box reading

If a slot's box is missing, empty, or illegible, omit that slot entirely (do not invent episodes).
Respond with JSON only — no markdown.`;

/**
 * Strict local validation. Rejects; never salvages.
 * @param {unknown} payload
 * @param {('blue'|'red')[]} [requestedSlots] if provided, every result.slot must be in this set (extras OK in raw but filtered by caller)
 * @returns {{ results: object[] }}
 */
export function validateOcrPayload(payload, requestedSlots) {
  if (!Array.isArray(payload)) {
    throw new OcrInvalid('OCR payload must be a JSON array');
  }

  const seen = new Set();
  const results = [];

  for (let i = 0; i < payload.length; i++) {
    const item = payload[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OcrInvalid(`OCR item[${i}] must be an object`);
    }

    const slot = item.slot;
    if (slot !== 'blue' && slot !== 'red') {
      throw new OcrInvalid(`OCR item[${i}].slot must be "blue" or "red"`);
    }
    if (seen.has(slot)) {
      throw new OcrInvalid(`OCR duplicate slot "${slot}"`);
    }
    seen.add(slot);

    if (requestedSlots?.length) {
      // Allow non-requested slots in the array (camera sees both); validation still requires schema.
      // Caller binds only requested slots.
    }

    const vn = item.volume_number;
    if (
      typeof vn !== 'number' ||
      !Number.isInteger(vn) ||
      vn < THRESHOLDS.volumeNumberMin ||
      vn > THRESHOLDS.volumeNumberMax
    ) {
      throw new OcrInvalid(
        `OCR item[${i}].volume_number must be int ${THRESHOLDS.volumeNumberMin}-${THRESHOLDS.volumeNumberMax}`,
      );
    }

    if (!Array.isArray(item.episodes)) {
      throw new OcrInvalid(`OCR item[${i}].episodes must be an array`);
    }
    if (
      item.episodes.length < THRESHOLDS.episodesMin ||
      item.episodes.length > THRESHOLDS.episodesMax
    ) {
      throw new OcrInvalid(
        `OCR item[${i}].episodes length must be ${THRESHOLDS.episodesMin}-${THRESHOLDS.episodesMax}`,
      );
    }
    for (let j = 0; j < item.episodes.length; j++) {
      const ep = item.episodes[j];
      if (typeof ep !== 'string' || ep.trim() === '') {
        throw new OcrInvalid(
          `OCR item[${i}].episodes[${j}] must be a nonempty string`,
        );
      }
    }

    const conf = item.confidence;
    if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      throw new OcrInvalid(
        `OCR item[${i}].confidence must be a finite number in [0,1]`,
      );
    }

    if (typeof item.series !== 'string') {
      throw new OcrInvalid(`OCR item[${i}].series must be a string`);
    }
    if (typeof item.volume_title !== 'string') {
      throw new OcrInvalid(`OCR item[${i}].volume_title must be a string`);
    }

    results.push({
      slot,
      series: item.series,
      volume_number: vn,
      volume_title: item.volume_title,
      episodes: item.episodes.map((e) => e.trim()),
      confidence: conf,
    });
  }

  return { results };
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new OcrInvalid('OCR response text empty');
  }
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new OcrInvalid(`OCR JSON parse failed: ${err.message}`, err);
  }
}

async function callGemini(imagePath, extraPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new OcrInvalid('GEMINI_API_KEY missing');

  const model = process.env.GEMINI_OCR_MODEL?.trim() || OCR_MODEL;
  const bytes = await fsp.readFile(imagePath);
  const b64 = bytes.toString('base64');
  const mime =
    imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const prompt = extraPrompt
    ? `${SCAN_PROMPT}\n\nPrevious response failed validation:\n${extraPrompt}\nReturn corrected JSON only.`
    : SCAN_PROMPT;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          createPartFromText(prompt),
          createPartFromBase64(b64, mime),
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: OCR_RESPONSE_SCHEMA,
    },
  });

  const text = response.text ?? '';
  return { text, model, rawResponse: response };
}

/**
 * @param {string} imagePath
 * @param {('blue'|'red')[]} requestedSlots
 * @returns {Promise<{scanId:string, results:object[], raw:string, model:string}>}
 */
export async function scanBoxes(imagePath, requestedSlots) {
  const scanId = randomUUID();
  const slots = (requestedSlots || []).map((s) => String(s).toLowerCase());

  let lastError = null;
  let rawText = '';
  let model = process.env.GEMINI_OCR_MODEL?.trim() || OCR_MODEL;

  for (let attempt = 0; attempt < 2; attempt++) {
    const extra = attempt === 0 ? null : lastError?.message || String(lastError);
    try {
      const { text, model: usedModel } = await callGemini(imagePath, extra);
      rawText = text;
      model = usedModel;
      await saveRawBesideImage(imagePath, scanId, text);

      const parsed = parseJsonText(text);
      const { results: all } = validateOcrPayload(parsed, slots);
      const results = slots.length
        ? all.filter((r) => slots.includes(r.slot))
        : all;

      return { scanId, results, raw: text, model, allResults: all };
    } catch (err) {
      lastError = err instanceof OcrInvalid ? err : new OcrInvalid(err.message, err);
      if (attempt === 0 && rawText) {
        // already saved on success path; save failed raw too
      }
      if (rawText) await saveRawBesideImage(imagePath, scanId, rawText, attempt);
    }
  }

  if (rawText) await saveRawBesideImage(imagePath, scanId, rawText, 'final');
  throw lastError || new OcrInvalid('OCR failed');
}

async function saveRawBesideImage(imagePath, scanId, text, suffix = '') {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const tag = suffix === '' ? '' : `.${suffix}`;
  const out = path.join(dir, `${base}.${scanId}${tag}.ocr.json`);
  await fsp.writeFile(
    out,
    typeof text === 'string' ? text : JSON.stringify(text, null, 2),
    'utf8',
  );
  return out;
}
