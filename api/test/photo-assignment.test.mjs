import test from 'node:test';
import assert from 'node:assert/strict';

import { assignOrphanPhotos } from '../dist/lib/extract.js';

/**
 * Photo assignment is the one piece of pure logic in the extraction path that
 * can be wrong in a way nobody notices: a punch item that reaches a
 * subcontractor with someone else's photo attached still looks completely
 * normal in Procore. These cases are drawn from what the reference document
 * actually produces.
 */

const item = (over = {}) => ({
  source_number: null,
  title: 'x',
  description: null,
  location: null,
  room: null,
  sheet: null,
  status: null,
  assignee: null,
  due_date: null,
  trade_guess: null,
  photo_indexes: [],
  confidence: 'high',
  ...over,
});

/** Three stacked rows, like a page of the Darden export. */
const region = (index, top, bottom) => ({ index, top, bottom, left: 0.38, right: 0.66 });

test('keeps a clean assignment untouched', () => {
  const items = [item({ photo_indexes: [0] }), item({ photo_indexes: [1, 2] })];
  const photos = [region(0, 0.03, 0.25), region(1, 0.28, 0.49), region(2, 0.28, 0.49)];

  const out = assignOrphanPhotos(items, photos, []);

  assert.deepEqual(out[0].photo_indexes, [0]);
  assert.deepEqual(out[1].photo_indexes, [1, 2]);
});

test('page furniture is dropped, never attached to an item', () => {
  // Page 2 of the reference document: a restaurant photo in the header and an
  // app-store QR code in the footer, both of which the shape detector finds.
  const items = [item({ photo_indexes: [1] })];
  const photos = [region(0, 0.01, 0.12), region(1, 0.17, 0.38), region(2, 0.9, 0.96)];

  const out = assignOrphanPhotos(items, photos, [0, 2]);

  assert.deepEqual(out[0].photo_indexes, [1]);
});

test('furniture is not resurrected by the orphan pass', () => {
  // The dangerous case: the model assigns nothing, so every region looks like an
  // orphan. Without the furniture guard the header logo lands on item one.
  const items = [item(), item()];
  const photos = [region(0, 0.01, 0.12), region(1, 0.3, 0.5), region(2, 0.6, 0.8)];

  const out = assignOrphanPhotos(items, photos, [0]);

  assert.equal(out.flatMap((i) => i.photo_indexes).includes(0), false);
  assert.deepEqual(out.flatMap((i) => i.photo_indexes).sort(), [1, 2]);
});

test('a photo claimed twice is kept only by the first claimant', () => {
  const items = [item({ photo_indexes: [0] }), item({ photo_indexes: [0] })];
  const photos = [region(0, 0.1, 0.3)];

  const out = assignOrphanPhotos(items, photos, []);

  assert.deepEqual(out[0].photo_indexes, [0]);
  assert.deepEqual(out[1].photo_indexes, []);
});

test('indexes that do not exist are discarded', () => {
  const items = [item({ photo_indexes: [0, 7] })];
  const photos = [region(0, 0.1, 0.3)];

  const out = assignOrphanPhotos(items, photos, []);

  assert.deepEqual(out[0].photo_indexes, [0]);
});

test('unclaimed photos fall to the item nearest them vertically', () => {
  // Model returned items in order but assigned no photos at all — the fallback
  // has only ordinal position to work from.
  const items = [item(), item(), item()];
  const photos = [region(0, 0.03, 0.25), region(1, 0.35, 0.55), region(2, 0.7, 0.9)];

  const out = assignOrphanPhotos(items, photos, []);

  assert.deepEqual(out[0].photo_indexes, [0]);
  assert.deepEqual(out[1].photo_indexes, [1]);
  assert.deepEqual(out[2].photo_indexes, [2]);
});

test('an orphan joins the row it sits beside, not the row above', () => {
  // Two photos side by side on row two: the model claimed one and missed the
  // other. The missed one must join row two, not row one.
  const items = [item({ photo_indexes: [0] }), item({ photo_indexes: [1] }), item()];
  const photos = [
    region(0, 0.03, 0.25),
    { index: 1, top: 0.28, bottom: 0.49, left: 0.38, right: 0.66 },
    { index: 2, top: 0.28, bottom: 0.49, left: 0.69, right: 0.96 },
  ];

  const out = assignOrphanPhotos(items, photos, []);

  assert.deepEqual(out[1].photo_indexes, [1, 2]);
  assert.deepEqual(out[0].photo_indexes, [0]);
});

test('a page with no photos leaves every item with none', () => {
  const items = [item({ photo_indexes: [0, 1] })];

  const out = assignOrphanPhotos(items, [], []);

  assert.deepEqual(out[0].photo_indexes, []);
});

test('every region being furniture is the same as having no photos', () => {
  const items = [item({ photo_indexes: [0] })];
  const photos = [region(0, 0.01, 0.12)];

  const out = assignOrphanPhotos(items, photos, [0]);

  assert.deepEqual(out[0].photo_indexes, []);
});
