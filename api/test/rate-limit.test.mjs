import test from 'node:test';
import assert from 'node:assert/strict';

import { rateLimitWaitMs } from '../dist/lib/procore.js';

/**
 * A real push failed here, and the error message was the bug describing itself:
 * "Procore rate limit reached; it resets in about 0s."
 *
 * `X-Rate-Limit-Reset` is not guaranteed to be an epoch second, and the original
 * code assumed it was. Given a seconds-from-now value, `reset * 1000 - Date.now()`
 * is hugely negative, clamped to zero, and the retry fired immediately — four
 * times, against a limit still in force. Every remaining item in the push then
 * failed. The invariant worth pinning is simply: never wait less than the normal
 * backoff, whatever the header says.
 */
const backoff = (attempt) => Math.min(2 ** attempt * 1000, 16_000);

test('a seconds-from-now header is read as a duration, not an epoch', () => {
  assert.equal(rateLimitWaitMs('45', 0), 45_000);
});

test('an epoch-second header is read as an absolute time', () => {
  const inTwentySeconds = Math.floor((Date.now() + 20_000) / 1000);
  const waited = rateLimitWaitMs(String(inTwentySeconds), 0);
  assert.ok(waited > 18_000 && waited <= 21_000, `expected ~20s, got ${waited}`);
});

test('a past epoch never produces an instant retry', () => {
  const anHourAgo = Math.floor((Date.now() - 3_600_000) / 1000);
  assert.equal(rateLimitWaitMs(String(anHourAgo), 2), backoff(2));
});

test('a missing or nonsense header falls back to backoff', () => {
  for (const header of [null, '', 'soon', '0', '-5', 'NaN']) {
    assert.equal(rateLimitWaitMs(header, 1), backoff(1), `header ${JSON.stringify(header)}`);
  }
});

test('backoff grows with the attempt, so retries spread out', () => {
  const waits = [0, 1, 2, 3].map((a) => rateLimitWaitMs(null, a));
  for (let i = 1; i < waits.length; i += 1) assert.ok(waits[i] > waits[i - 1]);
});
