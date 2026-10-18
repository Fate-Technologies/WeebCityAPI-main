import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncDirection, normalizeSyncTitle } from './integrationSync.js';

test('syncDirection exports when local progress is ahead', () => {
  assert.equal(syncDirection(12, 8), 'export');
});

test('syncDirection imports when remote progress is ahead', () => {
  assert.equal(syncDirection(5, 10), 'import');
});

test('syncDirection breaks tied chapters by volumes', () => {
  assert.equal(syncDirection(10, 10, 3, 1), 'export');
  assert.equal(syncDirection(10, 10, 1, 3), 'import');
});

test('syncDirection lets the local status win fully tied progress', () => {
  assert.equal(syncDirection(12, 12), 'export');
  assert.equal(syncDirection(12, 12, 2, 2), 'export');
  assert.equal(syncDirection(0, 0), 'export');
});

test('normalizeSyncTitle ignores case and punctuation', () => {
  assert.equal(normalizeSyncTitle('One Piece'), normalizeSyncTitle('one-piece!'));
  assert.equal(normalizeSyncTitle('  Re:ZERO '), normalizeSyncTitle('re zero'));
  assert.equal(normalizeSyncTitle(null), '');
});
