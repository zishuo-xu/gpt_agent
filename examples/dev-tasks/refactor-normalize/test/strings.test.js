import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForSearch, normalizeForUrl } from '../src/strings.js';

test('normalizers preserve their current behavior', () => {
  for (const value of [' Hello World ', 'Already-normal']) {
    assert.equal(normalizeForSearch(value), value.trim().toLowerCase().replaceAll(' ', '-'));
    assert.equal(normalizeForUrl(value), value.trim().toLowerCase().replaceAll(' ', '-'));
  }
});
