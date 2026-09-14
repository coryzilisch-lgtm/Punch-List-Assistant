import test from 'node:test';
import assert from 'node:assert/strict';

import { isUnsentImport } from '../dist/lib/procore.js';

/**
 * The draft sweep offers to send items on somebody's live project, so being
 * wrong here means reaching past what the app was asked to do. Both halves of
 * the predicate are load-bearing and neither is obvious from the call site.
 */
const OURS = 15487817;
const draft = (over = {}) => ({
  workflow_status: 'draft',
  created_by: { id: OURS },
  ...over,
});

test('a draft this integration created is ours to finish', () => {
  assert.equal(isUnsentImport(draft(), OURS), true);
});

/**
 * A superintendent writing a punch item in Procore leaves it in Draft until they
 * are ready. Sweeping those up would send someone else's unfinished work.
 */
test("someone else's draft is left alone", () => {
  assert.equal(isUnsentImport(draft({ created_by: { id: 11921505 } }), OURS), false);
  assert.equal(isUnsentImport(draft({ created_by: null }), OURS), false);
  assert.equal(isUnsentImport(draft({ created_by: {} }), OURS), false);
});

test('an item that already left Draft is not resent', () => {
  for (const workflow of ['initiated', 'closed', 'ready_for_review', 'work_required']) {
    assert.equal(isUnsentImport(draft({ workflow_status: workflow }), OURS), false, workflow);
  }
});

/** Procore's status field is Open/Closed and says nothing about the workflow. */
test('status is not mistaken for the workflow state', () => {
  assert.equal(isUnsentImport({ status: 'Open', created_by: { id: OURS } }, OURS), false);
  assert.equal(isUnsentImport(draft({ status: 'Open' }), OURS), true);
});

/**
 * Without an identity every item looks like someone else's — the safe way to be
 * wrong. Returning true here would offer to send the whole project.
 */
test('an unknown identity claims nothing', () => {
  assert.equal(isUnsentImport(draft(), null), false);
});

test('a capitalised workflow value still matches', () => {
  assert.equal(isUnsentImport(draft({ workflow_status: 'Draft' }), OURS), true);
});
