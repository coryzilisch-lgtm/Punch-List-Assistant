import test from 'node:test';
import assert from 'node:assert/strict';

import { reasoningParams } from '../dist/lib/model.js';

/**
 * `thinking: {type:'adaptive'}` and `output_config.effort` are rejected with a
 * 400 — not ignored — by models older than the 4.6 generation. Since
 * PUNCH_EXTRACT_MODEL is a plain env var an operator can point anywhere, sending
 * them unconditionally turns "try a cheaper model" into "every page fails".
 * These cases pin the gate that prevents that.
 */

const clearEnv = () => {
  delete process.env.PUNCH_EXTRACT_REASONING;
  delete process.env.PUNCH_EXTRACT_EFFORT;
};

test('modern models get adaptive thinking and effort', () => {
  clearEnv();
  for (const model of [
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-fable-5',
  ]) {
    const r = reasoningParams(model);
    assert.deepEqual(r.thinking, { type: 'adaptive' }, `${model} should get adaptive thinking`);
    assert.equal(r.effort, 'medium', `${model} should get effort`);
  }
});

test('Haiku 4.5 gets neither — both would 400', () => {
  clearEnv();
  const r = reasoningParams('claude-haiku-4-5');
  assert.equal(r.thinking, undefined);
  assert.equal(r.effort, undefined);
});

test('Sonnet 4.5 gets neither', () => {
  clearEnv();
  assert.deepEqual(reasoningParams('claude-sonnet-4-5'), {});
});

test('an unrecognized Foundry deployment name falls back to the plain request', () => {
  // On Foundry the model id is whatever the deployment was named. Degrading to
  // a request every model accepts beats 400-ing every page.
  clearEnv();
  assert.deepEqual(reasoningParams('punch-list-prod'), {});
  assert.deepEqual(reasoningParams(''), {});
});

test('PUNCH_EXTRACT_REASONING=adaptive forces it on for a custom deployment name', () => {
  clearEnv();
  process.env.PUNCH_EXTRACT_REASONING = 'adaptive';
  const r = reasoningParams('our-claude-deployment');
  assert.deepEqual(r.thinking, { type: 'adaptive' });
  assert.equal(r.effort, 'medium');
  clearEnv();
});

test('PUNCH_EXTRACT_REASONING=basic turns it off even on a modern model', () => {
  clearEnv();
  process.env.PUNCH_EXTRACT_REASONING = 'basic';
  assert.deepEqual(reasoningParams('claude-opus-5'), {});
  clearEnv();
});

test('effort is configurable but only travels with adaptive thinking', () => {
  clearEnv();
  process.env.PUNCH_EXTRACT_EFFORT = 'high';
  assert.equal(reasoningParams('claude-opus-5').effort, 'high');
  // Set on a model that cannot accept it, it is still withheld.
  assert.equal(reasoningParams('claude-haiku-4-5').effort, undefined);
  clearEnv();
});
