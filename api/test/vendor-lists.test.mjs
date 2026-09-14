import test from 'node:test';
import assert from 'node:assert/strict';

import { listCandidates, mergeVendors, vendorsFromDirectory } from '../dist/lib/procore.js';
import { isProcoreIdShaped } from '../dist/lib/fabric.js';

process.env.PROCORE_COMPANY_ID ||= '18895';

/**
 * The 404 that started this: Trades was asked for with `?project_id=` and
 * Vendors under `/companies/{id}/`, and both were on the wrong side of Procore's
 * nested-vs-flat inconsistency.
 *
 * The live tenant answered on 2026-09-14, and the answer is why neither could
 * have been reasoned out: they are MIRROR IMAGES. Trades works **nested**
 * (`/companies/18895/trades`, 190 rows) and 404s flat. Vendors works
 * **project-scoped** (`/projects/{id}/vendors`, 30 rows) and flat with
 * `company_id`, and 404s under `/companies/{id}/vendors`. Whichever rule you
 * pick, one of the two breaks it.
 *
 * These tests fix the properties that keep discovery honest.
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
    assert.ok(
      labels.some((l) => l.includes('/projects/')),
      `${group} must try the project-scoped path`,
    );
    assert.ok(labels.length >= 4, `${group} should try several candidates, got ${labels.length}`);
  }
});

/**
 * The paths the tenant confirmed lead, so steady-state discovery is one request
 * per list rather than five against a quota shared with the Safety Dashboard
 * ingest. The first live probe run drew a 429 on two other lookups, so this is
 * not theoretical.
 */
test('the confirmed path is tried first for each list', () => {
  assert.equal(listCandidates('trades', 603781)[0].path, '/rest/v1.0/companies/18895/trades');
  assert.equal(listCandidates('vendors', 603781)[0].path, '/rest/v1.0/projects/603781/vendors');
});

/** A candidate list with a duplicate wastes a request against a shared quota. */
test('no candidate path is tried twice', () => {
  for (const group of ['trades', 'vendors']) {
    const keys = listCandidates(group, 603781).map((c) => `${c.path}?${JSON.stringify(c.query)}`);
    assert.equal(new Set(keys).size, keys.length, `${group} has a duplicate candidate`);
  }
});

/** Scope is what drives the `onProject` flag, so it has to match the path. */
test('a candidate is scoped project exactly when its path names a project', () => {
  for (const group of ['trades', 'vendors']) {
    for (const c of listCandidates(group, 603781)) {
      const namesProject = c.path.includes('/projects/') || 'project_id' in c.query;
      assert.equal(c.scope, namesProject ? 'project' : 'company', `${c.label} has the wrong scope`);
    }
  }
});

/**
 * THE BUG THE LIVE PROBE CAUGHT. `onProject` was derived from the project's user
 * directory, on the assumption that it holds the subs. On project 603781 it does
 * not — every row resolves to Buffalo Construction Inc., because the directory is
 * Buffalo's own staff. So the general contractor was flagged "on this project"
 * and floated to the top of the picker, above the 30 subs a punch item actually
 * gets assigned to.
 *
 * The project-scoped vendor list is the source of that fact, not the directory.
 */
test('a project-scoped list marks every row as on this job', () => {
  const merged = mergeVendors(
    [
      { id: 10263673, name: 'Buffalo Construction Inc.' },
      { id: 44, name: 'Acme Drywall' },
    ],
    'project',
    [{ id: 10263673, name: 'Buffalo Construction Inc.' }],
  );
  assert.deepEqual(merged.map((v) => [v.name, Boolean(v.onProject)]), [
    ['Buffalo Construction Inc.', true],
    ['Acme Drywall', true],
  ]);
});

test('the GC alone in the directory cannot outrank the subs', () => {
  const merged = mergeVendors(
    [
      { id: 44, name: 'Acme Drywall' },
      { id: 10263673, name: 'Buffalo Construction Inc.' },
    ],
    'project',
    [{ id: 10263673, name: 'Buffalo Construction Inc.' }],
  );
  // Every row is on the job, so nothing is promoted above anything else and the
  // picker stays alphabetical. The regression was exactly one row being lifted.
  assert.equal(merged.filter((v) => v.onProject).length, 2);
});

/** With only a company-wide list, the directory is what identifies this job's subs. */
test('a company-wide list is marked from the directory', () => {
  const merged = mergeVendors(
    [
      { id: 44, name: 'Acme Drywall' },
      { id: 99, name: 'Never Been Here Inc.' },
    ],
    'company',
    [{ id: 44, name: 'Acme Drywall' }],
  );
  assert.equal(merged.find((v) => v.id === 44).onProject, true);
  assert.equal(merged.find((v) => v.id === 99).onProject, undefined);
});

/**
 * The project directory is the vendor source that needs no new endpoint. But a
 * company is only usable if it carries Procore's own numeric id: a name alone
 * cannot be sent, and sending some other system's key would assign the punch
 * item to the wrong company silently, which is the failure mode this integration
 * has already shipped three times.
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

/** A company the vendor list missed is still pickable — losing one is a dead end. */
test('a directory company absent from the vendor list is added', () => {
  const merged = mergeVendors([{ id: 44, name: 'Acme Drywall' }], 'company', [
    { id: 77, name: 'Late Addition Electric' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((v) => v.id === 77).onProject, true);
});

test('a vendor in both sources is listed once', () => {
  const merged = mergeVendors([{ id: 7, name: 'Zeta Roofing' }], 'company', [
    { id: 7, name: 'Zeta Roofing' },
  ]);
  assert.deepEqual(merged, [{ id: 7, name: 'Zeta Roofing', onProject: true }]);
});

/**
 * The Fabric shape test rules a column OUT; it never rules one IN. A GUID or a
 * normalized name is definitely not a Procore id, which is the useful half. The
 * other half is settled by intersecting the column's values with the ids Procore
 * actually returned — see `matchedProcoreVendorIds`.
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
