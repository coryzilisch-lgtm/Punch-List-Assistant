import test from 'node:test';
import assert from 'node:assert/strict';

import { listCandidates, mergeVendors, vendorsFromDirectory } from '../dist/lib/procore.js';
import { isProcoreIdShaped } from '../dist/lib/fabric.js';

process.env.PROCORE_COMPANY_ID ||= '18895';

/**
 * The 404 that started this: Trades was asked for with `?project_id=` and
 * Vendors under `/companies/{id}/`, and at least one of those was on the wrong
 * side of Procore's nested-vs-flat inconsistency. The reference that would
 * settle it is unreachable from the build environment, so the app tries the
 * candidates and keeps what answers.
 *
 * These tests fix the two properties that make that safe. First: both shapes are
 * always offered, so a rename that quietly drops one cannot reintroduce the
 * original bug while the probe still reports green.
 */
test('both the nested and the flat shape are offered for each list', () => {
  for (const group of ['trades', 'vendors']) {
    const labels = listCandidates(group, 603781).map((c) => c.label);
    assert.ok(
      labels.some((l) => l.includes('/companies/')),
      `${group} must try the nested company path`,
    );
    assert.ok(
      labels.some((l) => l.includes('company_id')),
      `${group} must try the flat company_id path`,
    );
    assert.ok(labels.length >= 4, `${group} should try several candidates, got ${labels.length}`);
  }
});

/** A candidate list with a duplicate wastes a request against a shared quota. */
test('no candidate path is tried twice', () => {
  for (const group of ['trades', 'vendors']) {
    const keys = listCandidates(group, 603781).map((c) => `${c.path}?${JSON.stringify(c.query)}`);
    assert.equal(new Set(keys).size, keys.length, `${group} has a duplicate candidate`);
  }
});

/**
 * The project directory is the vendor source that needs no new endpoint — that
 * call already succeeds today. But a company is only usable if it carries
 * Procore's own numeric id: a name alone cannot be sent, and sending some other
 * system's key would assign the punch item to the wrong company silently, which
 * is the failure mode this integration has already shipped three times.
 */
test('a directory vendor without a Procore id is refused, not guessed at', () => {
  const vendors = vendorsFromDirectory([
    { id: 1, name: 'A', vendor: { id: 10263673, name: 'Acme Drywall' } },
    { id: 2, name: 'B', vendor: { name: 'No Id Mechanical' } },
    { id: 3, name: 'C', vendor: { id: 'not-a-number', name: 'Bad Key Electric' } },
    { id: 4, name: 'D', vendor: null },
    { id: 5, name: 'E' },
  ]);
  assert.deepEqual(vendors, [{ id: 10263673, name: 'Acme Drywall' }]);
});

test('one company with three people on the job appears once', () => {
  const vendors = vendorsFromDirectory([
    { id: 1, name: 'A', vendor: { id: 7, name: 'Zeta Roofing' } },
    { id: 2, name: 'B', vendor: { id: 7, name: 'Zeta Roofing' } },
    { id: 3, name: 'C', vendor: { id: 4, name: 'Apex Glass' } },
  ]);
  assert.deepEqual(vendors.map((v) => v.id), [4, 7]);
});

/**
 * The subs on this job come first, but the company-wide list is kept alongside
 * rather than replacing it. A vendor missing from the picker is a dead end in
 * the field; a long picker is an annoyance, and the field is a type-ahead.
 */
test('the company-wide list is kept, with on-project subs flagged', () => {
  const merged = mergeVendors(
    [{ id: 7, name: 'Zeta Roofing' }],
    [
      { id: 7, name: 'Zeta Roofing' },
      { id: 9, name: 'Distant Vendor' },
    ],
  );
  assert.equal(merged.length, 2, 'the shared vendor must not be listed twice');
  assert.deepEqual(merged.find((v) => v.id === 7), { id: 7, name: 'Zeta Roofing', onProject: true });
  assert.equal(merged.find((v) => v.id === 9).onProject, undefined);
});

test('a company-wide list alone still populates the picker', () => {
  const merged = mergeVendors([], [{ id: 9, name: 'Only Source' }]);
  assert.deepEqual(merged, [{ id: 9, name: 'Only Source' }]);
});

/**
 * The Fabric shape test rules a column OUT; it never rules one IN. A GUID or a
 * normalized name is definitely not a Procore id, which is the useful half — the
 * other half needs a person who knows how Vendor Compliance keys its rows.
 */
test('a GUID or a name is never mistaken for a Procore id', () => {
  assert.equal(isProcoreIdShaped('a222cf3b-67c8-43da-a50d-41e20b7ad409'), false);
  assert.equal(isProcoreIdShaped('acme drywall'), false);
  assert.equal(isProcoreIdShaped(''), false);
  assert.equal(isProcoreIdShaped(null), false);
  assert.equal(isProcoreIdShaped(-5), false);
  assert.equal(isProcoreIdShaped(10263673), true);
  assert.equal(isProcoreIdShaped('10263673'), true);
});
