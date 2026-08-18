'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitIntoWindows } = require('../../../src/services/backtesting/reversal-walk-forward');

test('splitIntoWindows produces the requested number of equal, non-overlapping, sequential windows', () => {
  const start = 0;
  const end = 1000;
  const windows = splitIntoWindows(start, end, 4);
  assert.equal(windows.length, 4);
  assert.equal(windows[0].startMs, 0);
  assert.equal(windows[3].endMs, 1000); // the last window's end must exactly equal the requested end
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(windows[i].startMs, windows[i - 1].endMs); // contiguous, no gaps or overlaps
  }
});

test('splitIntoWindows handles a range that does not divide evenly, without losing or overlapping time', () => {
  const windows = splitIntoWindows(0, 1000, 3); // 333.33... per window
  assert.equal(windows.length, 3);
  assert.equal(windows[0].startMs, 0);
  assert.equal(windows[2].endMs, 1000); // rounding remainder absorbed into the last window
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(windows[i].startMs, windows[i - 1].endMs);
  }
});
