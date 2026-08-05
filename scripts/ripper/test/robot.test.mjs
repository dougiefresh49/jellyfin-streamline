import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseInfoOutput, parseRobotLine } from '../lib/robot.mjs';
import { classifyTitles } from '../lib/makemkv.mjs';

const fixture = (name) => readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

test('parseRobotLine handles quotes, escaped quotes, commas, and empty fields', () => {
  assert.deepEqual(parseRobotLine('MSG:1,,2,"a, b and ""quote""",""'), {
    type: 'MSG', fields: ['1', '', '2', 'a, b and "quote"', ''],
  });
});

test('parses real TMNT info fixture', async () => {
  const parsed = parseInfoOutput(await fixture('info-tmnt-vol1-disc0.txt'));
  assert.equal(parsed.titles.length, 6);
  assert.deepEqual(parsed.titles[0], { id: 0, chapters: 13, duration_s: 3848, sizeStr: '2.4 GB', outName: 'B1_t00.mkv' });
  assert.equal(parsed.discLabel, 'TMNT vol 1');
});

test('parses real drive enumeration fixture', async () => {
  const parsed = parseInfoOutput(await fixture('drv-enumeration.txt'));
  assert.deepEqual(parsed.drives[0], {
    index: 0,
    mediaPresent: true,
    driveName: 'DVD+R-DL Slimtype DVD A DS8A4S JL61 007080176998',
    discLabel: 'TMNT vol 1',
    osDevice: '/dev/rdisk5',
  });
});

test('classifies TMNT fixture as playall with five extras', async () => {
  const { titles } = parseInfoOutput(await fixture('info-tmnt-vol1-disc0.txt'));
  assert.deepEqual(classifyTitles(titles, 3), {
    mode: 'playall', episodeTitleIds: [0], playallId: 0, extraIds: [1, 2, 3, 4, 5],
  });
});

test('classifies Courage-style titles and excludes sum-duration play-all', () => {
  const titles = [
    { id: 0, duration_s: 3960, chapters: 9 },
    { id: 1, duration_s: 1320, chapters: 3 },
    { id: 2, duration_s: 1300, chapters: 3 },
    { id: 3, duration_s: 1340, chapters: 3 },
    { id: 4, duration_s: 300, chapters: 1 },
  ];
  assert.deepEqual(classifyTitles(titles, 3), {
    mode: 'per-title', episodeTitleIds: [1, 2, 3], playallId: 0, extraIds: [4],
  });
});
