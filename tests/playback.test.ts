import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSeek, nextStopAfterSeek, hasReachedChapterEnd } from '../src/playback.ts';

test('projection seeks stay inside the loaded video', () => {
  assert.equal(clampSeek(30, 100), 30);
  assert.equal(clampSeek(-10, 100), 0);
  assert.equal(clampSeek(120, 100), 100);
  assert.equal(clampSeek(Infinity, 100), 0);
  assert.equal(clampSeek(10, NaN), 0);
});
test('a seek beyond the chapter end returns to unrestricted playback', () => {
  assert.equal(nextStopAfterSeek(25, 30), 30);
  assert.equal(nextStopAfterSeek(31, 30), undefined);
  assert.equal(nextStopAfterSeek(30, 30), undefined);
  assert.equal(nextStopAfterSeek(10), undefined);
});
test('projection pauses exactly at or after the chapter end', () => {
  assert.equal(hasReachedChapterEnd(29.9, 30), false);
  assert.equal(hasReachedChapterEnd(30, 30), true);
  assert.equal(hasReachedChapterEnd(30.1, 30), true);
  assert.equal(hasReachedChapterEnd(30), false);
});
