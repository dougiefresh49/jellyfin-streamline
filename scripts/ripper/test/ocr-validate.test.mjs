import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOcrPayload,
  OcrInvalid,
} from '../lib/ocr.mjs';

describe('validateOcrPayload', () => {
  it('accepts a good two-slot payload', () => {
    const { results } = validateOcrPayload([
      {
        slot: 'blue',
        series: 'TMNT',
        volume_number: 1,
        volume_title: 'Things Change',
        episodes: ['Things Change', 'A Better Mousetrap', 'Attack of the Mousers'],
        confidence: 0.92,
      },
      {
        slot: 'red',
        series: 'TMNT',
        volume_number: 2,
        volume_title: '',
        episodes: ['Meet Casey Jones', 'Nano', 'Darkness on the Edge of Town'],
        confidence: 0.8,
      },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0].volume_number, 1);
    assert.equal(results[1].episodes.length, 3);
  });

  it('rejects non-array', () => {
    assert.throws(() => validateOcrPayload({ slot: 'blue' }), OcrInvalid);
  });

  it('rejects invalid slot enum', () => {
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'left',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: ['A'],
            confidence: 0.9,
          },
        ]),
      /slot/,
    );
  });

  it('rejects duplicate slots', () => {
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: ['A'],
            confidence: 0.9,
          },
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 2,
            volume_title: '',
            episodes: ['B'],
            confidence: 0.9,
          },
        ]),
      /duplicate/,
    );
  });

  it('rejects volume_number out of range / non-int', () => {
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 0,
            volume_title: '',
            episodes: ['A'],
            confidence: 0.9,
          },
        ]),
      /volume_number/,
    );
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1.5,
            volume_title: '',
            episodes: ['A'],
            confidence: 0.9,
          },
        ]),
      /volume_number/,
    );
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: '1',
            volume_title: '',
            episodes: ['A'],
            confidence: 0.9,
          },
        ]),
      /volume_number/,
    );
  });

  it('rejects empty episodes or wrong count', () => {
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: [],
            confidence: 0.9,
          },
        ]),
      /episodes/,
    );
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: ['', 'B'],
            confidence: 0.9,
          },
        ]),
      /nonempty/,
    );
  });

  it('rejects non-finite confidence outside 0-1', () => {
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: ['A'],
            confidence: 1.1,
          },
        ]),
      /confidence/,
    );
    assert.throws(
      () =>
        validateOcrPayload([
          {
            slot: 'blue',
            series: 'TMNT',
            volume_number: 1,
            volume_title: '',
            episodes: ['A'],
            confidence: Number.NaN,
          },
        ]),
      /confidence/,
    );
  });
});
