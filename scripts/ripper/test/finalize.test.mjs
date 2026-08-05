import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFinalizePlan } from '../lib/finalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPISODES = path.join(__dirname, '..', 'data', 'tmnt-2003-episodes.txt');

async function seedVol(staging, name, { episodes, verified, outputs, mode = 'playall' }) {
  const folder = path.join(staging, name);
  await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(
    path.join(folder, 'episodes.md'),
    [
      'volume_number: 1',
      `verified: ${verified ? 'true' : 'false'}`,
      '',
      ...episodes.map((e, i) => `${i + 1}. ${e}`),
      '',
    ].join('\n'),
  );
  const files = outputs || episodes.map((_, i) => `ep-${String(i + 1).padStart(2, '0')}.mkv`);
  for (const f of files) {
    await fsp.writeFile(path.join(folder, f), 'x');
  }
  await fsp.writeFile(
    path.join(folder, 'manifest.json'),
    JSON.stringify({
      mode,
      outputs: files,
      ocr: { verified, episodes, volume_number: 1 },
    }),
  );
  return folder;
}

describe('finalize gates', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ripper-finalize-'));
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('happy path maps vol1 episodes to S01E01-03', async () => {
    const staging = path.join(root, 'happy');
    const lib = path.join(root, 'lib-happy');
    await fsp.mkdir(lib, { recursive: true });
    await seedVol(staging, 'vol01-things-change', {
      verified: true,
      episodes: [
        'Things Change',
        'A Better Mousetrap',
        'Attack of the Mousers',
      ],
    });

    const plan = await buildFinalizePlan({
      stagingRoot: staging,
      libraryRoot: lib,
      episodesPath: EPISODES,
    });
    assert.equal(plan.ok, true, plan.reasons.join('; '));
    assert.equal(plan.volumes[0].mappings.length, 3);
    assert.equal(plan.volumes[0].mappings[0].code, 'S01E01');
    assert.equal(plan.volumes[0].mappings[1].code, 'S01E02');
    assert.equal(plan.volumes[0].mappings[2].code, 'S01E03');
    assert.match(plan.volumes[0].mappings[0].title, /Things Change/);
  });

  it('refuses when OCR episode count ≠ split file count', async () => {
    const staging = path.join(root, 'mismatch');
    await seedVol(staging, 'vol01-bad-count', {
      verified: true,
      episodes: [
        'Things Change',
        'A Better Mousetrap',
        'Attack of the Mousers',
      ],
      outputs: ['ep-01.mkv', 'ep-02.mkv'],
    });

    const plan = await buildFinalizePlan({
      stagingRoot: staging,
      libraryRoot: path.join(root, 'lib-mm'),
      episodesPath: EPISODES,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reasons.join(' '), /count mismatch/);
  });

  it('refuses ambiguous fuzzy matches', async () => {
    const staging = path.join(root, 'ambig');
    await seedVol(staging, 'vol01-ambig', {
      verified: true,
      episodes: ['The Shredder Strikes'],
      outputs: ['ep-01.mkv'],
    });

    const plan = await buildFinalizePlan({
      stagingRoot: staging,
      libraryRoot: path.join(root, 'lib-amb'),
      episodesPath: EPISODES,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reasons.join(' '), /ambiguous|no canonical/);
  });
});
