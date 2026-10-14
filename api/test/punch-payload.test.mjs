import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPunchItemPayload } from '../dist/lib/procore.js';

/**
 * The assignee key cost three production pushes to pin down.
 *
 * `assignee_id` is the obvious name and the wrong one: Procore accepted it,
 * filtered it out as an unpermitted parameter, and returned 200 with the item
 * still sitting in the service account's court. The real key is
 * `login_information_id`, read off an assignment Procore's own UI created.
 *
 * A silent drop leaves no failure to notice, so it gets a test rather than a
 * comment — a future "tidy up" that renames this back would otherwise ship
 * looking exactly like success.
 */
test('an assignee is sent as login_information_ids, the create field Procore documents', () => {
  // 2026-10-14: Procore's Create Punch Item reference names it. Never
  // `assignee_id`, and never alongside the nested form, which could assign one
  // person twice.
  const payload = buildPunchItemPayload({ name: 'Cracked tile', assigneeIds: [11921505] });
  assert.deepEqual(payload.login_information_ids, [11921505]);
  assert.ok(!('assignments' in payload));
  assert.ok(!('assignee_id' in payload));
});

test('people chosen with their company go as people; the company follows the person', () => {
  const payload = buildPunchItemPayload({ name: 'Cracked tile', assigneeIds: [1, 2], vendorId: 10263673 });
  assert.deepEqual(payload.login_information_ids, [1, 2]);
  assert.ok(!('assignments' in payload));
});

test('a company with no person keeps the nested form, the only shape known for it', () => {
  const payload = buildPunchItemPayload({ name: 'Cracked tile', vendorId: 10263673 });
  assert.deepEqual(payload.assignments, [{ vendor_id: 10263673 }]);
  assert.ok(!('login_information_ids' in payload));
});

/**
 * An unassigned item is meant to sit in nobody's court. Emitting an empty
 * `assignments` array invites Procore to apply a default, which would put work
 * in front of someone who never agreed to it.
 */
test('no assignee and no vendor means no assignments key at all', () => {
  const payload = buildPunchItemPayload({ name: 'Cracked tile' });
  assert.ok(!('assignments' in payload));
  assert.ok(!('login_information_ids' in payload));
});
