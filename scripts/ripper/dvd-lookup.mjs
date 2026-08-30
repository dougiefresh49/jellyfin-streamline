// Identify a DVD volume's episode list: cover image + Gemini web search grounding.
import fsp from 'node:fs/promises';
import { GoogleGenAI, createPartFromText, createPartFromBase64 } from '@google/genai';

const imagePath = process.argv[2];
if (!imagePath) { console.error('usage: node dvd-lookup.mjs <cover-image>'); process.exit(1); }

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
const bytes = await fsp.readFile(imagePath);
const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

const prompt = `This photo shows the FRONT COVER of a TV-series DVD. Do two things:

1. Read the cover: series name, any series/season subtitle, and the VOLUME title printed at the bottom.
2. SEARCH THE WEB for this exact DVD release and report which episodes are on this disc.

Report, clearly separated:
- What you READ from the cover (transcription only).
- What you FOUND ON THE WEB: the episode list for THIS disc, each with its season/episode
  number (SxxExx) and title, plus the URLs of the sources you used.
- Your confidence, and any conflict between sources.

Critical: do NOT fill gaps from memory. If web sources do not clearly state this disc's
contents, say so explicitly rather than guessing. Distinguish clearly between what a source
states and what you infer.`;

const ai = new GoogleGenAI({ apiKey });
const response = await ai.models.generateContent({
  model,
  contents: [{ role: 'user', parts: [
    createPartFromText(prompt),
    createPartFromBase64(bytes.toString('base64'), mime),
  ]}],
  config: { tools: [{ googleSearch: {} }] },
});

console.log('=== model:', model, '===\n');
console.log(response.text ?? '(no text)');

const gm = response.candidates?.[0]?.groundingMetadata;
if (gm?.groundingChunks?.length) {
  console.log('\n=== sources actually retrieved ===');
  for (const c of gm.groundingChunks) {
    if (c.web) console.log(' -', c.web.title, '|', c.web.uri);
  }
}
if (gm?.webSearchQueries?.length) console.log('\nqueries:', gm.webSearchQueries.join(' | '));
