import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMainTitle, matchMovie, folderName, EXPECTED, createProgressTracker, parseMovieFlag } from '../rip-movies.mjs';

const prgt = (name) => ({ type: 'PRGT', fields: ['0', '0', name] });
const prgv = (total) => ({ type: 'PRGV', fields: ['0', String(total), '65536'] });

const t = (id, minutes, chapters = 12) => ({ id, duration_s: minutes * 60, chapters });

test('picks the feature when it stands alone', () => {
  const got = pickMainTitle([t(0, 91), t(1, 4), t(2, 7)]);
  assert.equal(got.error, undefined);
  assert.equal(got.title.id, 0);
  assert.equal(got.duplicates, 0);
});

test('refuses when a second title is close enough to be the feature', () => {
  const got = pickMainTitle([t(0, 91), t(1, 87)]);
  assert.match(got.error, /two plausible features/);
});

test('collapses duplicate playlists and keeps the one with most chapters', () => {
  const got = pickMainTitle([t(0, 91, 12), { id: 1, duration_s: 91 * 60 + 3, chapters: 24 }, t(2, 5)]);
  assert.equal(got.title.id, 1);
  assert.equal(got.duplicates, 1);
});

test('refuses a disc whose longest title is too short for a feature', () => {
  const got = pickMainTitle([t(0, 22), t(1, 21)]);
  assert.match(got.error, /too short/);
});

test('refuses a looped/play-all style title', () => {
  const got = pickMainTitle([t(0, 240)]);
  assert.match(got.error, /too long/);
});

test('matches on the distinguishing words, not the shared franchise word', () => {
  assert.equal(matchMovie('TROLLS_WORLD_TOUR', new Set()).movie.title, 'Trolls World Tour');
  assert.equal(matchMovie('TROLLS_BAND_TOGETHER', new Set()).movie.title, 'Trolls Band Together');
});

test('a bare franchise label is ambiguous while both movies are unclaimed', () => {
  assert.match(matchMovie('TROLLS', new Set()).error, /cannot tell/);
});

test('falls back to elimination once the other movie is claimed', () => {
  const taken = new Set([folderName(EXPECTED[0])]);
  const got = matchMovie('DVD_VIDEO', taken);
  assert.equal(got.movie.title, 'Trolls Band Together');
  assert.equal(got.byElimination, true);
});

test('percent resets when a new total-phase starts', () => {
  const p = createProgressTracker();
  p.accept(prgt('Scanning CD-ROM devices'));
  p.accept(prgv(65536));
  assert.equal(p.percent, 100);
  p.accept(prgt('Saving all titles to MKV files'));
  assert.equal(p.percent, 0, 'a finished early phase must not latch progress at 100');
});

test('the loose finalize budget applies only in the write phase tail', () => {
  const p = createProgressTracker();
  // The exact latch that granted a whole rip the 30-minute stall budget.
  p.accept(prgt('Scanning CD-ROM devices'));
  p.accept(prgv(65536));
  assert.equal(p.finalizing, false, 'scanning at 100% is not finalizing');

  p.accept(prgt('Saving all titles to MKV files'));
  p.accept(prgv(32768));
  assert.equal(p.finalizing, false, 'mid-write is not finalizing');
  p.accept(prgv(65536));
  assert.equal(p.finalizing, true);
});

test('milestones are reported every 10 points, never backwards', () => {
  const p = createProgressTracker();
  p.accept(prgt('Saving all titles to MKV files'));
  assert.equal(p.accept(prgv(3277)), null, '5% is below the first milestone');
  assert.equal(p.accept(prgv(6554)), 10);
  assert.equal(p.accept(prgv(7000)), null, 'small forward moves stay quiet');
  assert.equal(p.accept(prgv(6554)), null, 'a backwards value reports nothing');
  assert.equal(p.accept(prgv(13108)), 20);
});

test('--movie parses "Title (Year)" and drops franchise stopwords from hints', () => {
  const m = parseMovieFlag(['node', 'x', 'rip', '--movie', 'Trolls (2016)', '--runtime', '92']);
  assert.deepEqual(m, { title: 'Trolls', year: 2016, runtimeMin: 92, hints: [] });
});

test('--movie keeps distinguishing words as hints', () => {
  const m = parseMovieFlag(['--movie=The Secret of the Ooze (1991)']);
  assert.deepEqual(m.hints, ['SECRET', 'OOZE']);
  assert.equal(m.runtimeMin, null, 'runtime is optional');
});

test('--movie rejects a title without a year', () => {
  assert.throws(() => parseMovieFlag(['--movie', 'Trolls']), /must look like/);
});

test('a single overriding movie matches any label by elimination', () => {
  const only = [{ title: 'Trolls', year: 2016, runtimeMin: 92, hints: [] }];
  const got = matchMovie('TROLLS', new Set(), only);
  assert.equal(got.movie.title, 'Trolls');
  assert.equal(got.byElimination, true);
});
