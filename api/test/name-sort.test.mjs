import test from 'node:test';
import assert from 'node:assert/strict';

import { lastNameKey, byLastName } from '../../dashboard/name-sort.js';

const order = (names) => names.map((name) => ({ name })).sort(byLastName).map((o) => o.name);

test('sorts by surname, not by the string as given', () => {
  assert.deepEqual(order(['Chad Dawson', 'Aaron Zilisch', 'Zoe Adams']), [
    'Zoe Adams',
    'Chad Dawson',
    'Aaron Zilisch',
  ]);
});

test('ignores a trailing company parenthetical', () => {
  // Procore's project_roles names arrive in exactly this shape.
  assert.equal(lastNameKey('Tim Fishburn (Buffalo Construction Inc.)').last, 'fishburn');
  assert.deepEqual(
    order(['Tim Fishburn (Buffalo Construction Inc.)', 'Kris Adams (Buffalo Construction Inc.)']),
    ['Kris Adams (Buffalo Construction Inc.)', 'Tim Fishburn (Buffalo Construction Inc.)'],
  );
});

test('handles "Last, First"', () => {
  assert.deepEqual(lastNameKey('Dawson, Chad'), { last: 'dawson', first: 'chad' });
});

test('a generational suffix does not become the surname', () => {
  assert.equal(lastNameKey('Robert Burns Jr.').last, 'burns');
  assert.equal(lastNameKey('Robert Burns III').last, 'burns');
});

test('same surname falls back to the forename', () => {
  assert.deepEqual(order(['Zoe Dawson', 'Chad Dawson']), ['Chad Dawson', 'Zoe Dawson']);
});

test('a middle name does not displace the surname', () => {
  assert.equal(lastNameKey('Mary Jane Watson').last, 'watson');
});

test('a single-word name sorts on itself rather than vanishing', () => {
  assert.equal(lastNameKey('Warehouse').last, 'warehouse');
  assert.deepEqual(order(['Warehouse', 'Zoe Adams']), ['Zoe Adams', 'Warehouse']);
});

test('empty and missing names do not throw', () => {
  assert.deepEqual(lastNameKey(''), { last: '', first: '' });
  assert.deepEqual(lastNameKey(null), { last: '', first: '' });
  assert.deepEqual(lastNameKey(undefined), { last: '', first: '' });
});
