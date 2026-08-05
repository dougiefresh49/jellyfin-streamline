import test from 'node:test';
import assert from 'node:assert/strict';
import { groupChapters } from '../lib/split.mjs';

function chapters(durations) {
  let time = 0;
  return durations.map((duration) => {
    const chapter = { start_s: time, end_s: time + duration };
    time += duration;
    return chapter;
  });
}

test('groups 13 uniform chapters into three near-equal contiguous groups', () => {
  const groups = groupChapters(chapters(Array(13).fill(300)), 3);
  assert.deepEqual(groups.flat(), Array.from({ length: 13 }, (_, index) => index));
  assert.deepEqual(groups.map((group) => group.length).sort(), [4, 4, 5]);
  const durations = groups.map((group) => group.length * 300);
  assert.ok(Math.max(...durations) - Math.min(...durations) <= 300);
});

test('balances non-uniform chapters with contiguous boundaries', () => {
  const input = chapters([100, 500, 200, 400, 300, 300]);
  const groups = groupChapters(input, 3);
  assert.deepEqual(groups, [[0, 1], [2, 3], [4, 5]]);
  const durations = groups.map((group) => group.reduce((sum, index) => sum + input[index].end_s - input[index].start_s, 0));
  assert.deepEqual(durations, [600, 600, 600]);
});
