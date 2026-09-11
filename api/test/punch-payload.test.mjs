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
test('an assignee is sent as login_information_id', () => {
  const payload = buildPunchItemPayload({ name: 'Cracked tile', assigneeIds: [11921505] });
  assert.deepEqual(payload.assignments, [{ login_information_id: 11921505 }]);
  assert.ok(!('assignee_id' in payload.assignments[0]));
});

test('a vendor rides along with the assignee when one was chosen', () => {
  const payload = buildPunchItemPayload({
    name: 'Cracked tile',
    assigneeIds: [1, 2],
    vendorId: 10263673,
  });
  assert.deepEqual(payload.assignments, [
    { login_information_id: 1, vendor_id: 10263673 },
    { login_information_id: 2, vendor_id: 10263673 },
  ]);
});

/**
 * An unassigned item is meant to sit in nobody's court. Emitting an empty
 * `assignments` array invites Procore to apply a default, which would put work
 * in front of someone who never agreed to it.
 */
test('no assignee and no vendor means no assignments key at all', () => {
  const payload = buildPunchItemPayload({ name: 'Cracked tile' });
  assert.ok(!('assignments' in payload));
});
