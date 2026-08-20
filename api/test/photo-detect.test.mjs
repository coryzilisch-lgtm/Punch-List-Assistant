import test from 'node:test';
import assert from 'node:assert/strict';

// The detector is shared with the browser, so the test imports it from where it
// lives rather than from a copy. `npm test` runs from api/, which is why the
// path climbs out.
import { detectPhotoRegions } from '../../dashboard/photo-detect.js';

/**
 * Synthetic pages, built to isolate the one judgement the detector makes:
 * photograph or not. It was validated against every page of the real reference
 * document, but that document is not in the repo (it is a client's), so these
 * stand in as the regression net — each one encodes a way the detector could
 * plausibly regress.
 */

const W = 640;
const H = 880;

function blankPage() {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  return px;
}

function set(px, x, y, r, g, b) {
  const o = (y * W + x) * 4;
  px[o] = r;
  px[o + 1] = g;
  px[o + 2] = b;
  px[o + 3] = 255;
}

/** A photographic block: mid-tone, varied, fully covering its rectangle. */
function drawPhoto(px, x0, y0, x1, y1, seed = 1) {
  let s = seed;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 70 + (s % 120); // squarely mid-tone
      set(px, x, y, v, v - 10, v + 15); // slight colour cast, like a real photo
    }
  }
}

/** Text: mostly white, with thin near-black strokes. */
function drawText(px, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y += 9) {
    for (let x = x0; x < x1; x++) {
      set(px, x, y, 20, 20, 20);
      set(px, x, y + 1, 20, 20, 20);
    }
  }
}

const within = (region, expected, tol = 0.05) =>
  Math.abs(region.top - expected.top) < tol &&
  Math.abs(region.bottom - expected.bottom) < tol &&
  Math.abs(region.left - expected.left) < tol &&
  Math.abs(region.right - expected.right) < tol;

test('finds a photograph and ignores a block of text', () => {
  const px = blankPage();
  drawText(px, 30, 40, 300, 300);
  drawPhoto(px, 360, 60, 600, 300);

  const regions = detectPhotoRegions(px, W, H);

  assert.equal(regions.length, 1, 'text must not register as a photo');
  assert.ok(
    within(regions[0], { top: 60 / H, bottom: 300 / H, left: 360 / W, right: 600 / W }),
    `region was ${JSON.stringify(regions[0])}`,
  );
});

test('a bright photo is still found', () => {
  // The case that killed the darkness-based approach: a white wall or a
  // stainless fridge, which is a photo with almost no dark pixels.
  const px = blankPage();
  let s = 7;
  for (let y = 100; y < 340; y++) {
    for (let x = 100; x < 400; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 185 + (s % 35); // bright, but not paper-white
      set(px, x, y, v, v, v - 4);
    }
  }

  const regions = detectPhotoRegions(px, W, H);

  assert.equal(regions.length, 1);
});

test('two photos side by side stay separate', () => {
  const px = blankPage();
  drawPhoto(px, 60, 100, 290, 340, 3);
  drawPhoto(px, 330, 100, 560, 340, 9);

  const regions = detectPhotoRegions(px, W, H);

  assert.equal(regions.length, 2);
  assert.ok(regions[0].left < regions[1].left, 'left-to-right order within a row');
});

test('reading order is top-to-bottom, then left-to-right', () => {
  const px = blankPage();
  drawPhoto(px, 330, 420, 560, 650, 4); // row 2, right
  drawPhoto(px, 60, 420, 290, 650, 5); // row 2, left
  drawPhoto(px, 60, 80, 290, 310, 6); // row 1

  const regions = detectPhotoRegions(px, W, H);

  assert.equal(regions.length, 3);
  assert.ok(regions[0].top < regions[1].top, 'row 1 first');
  assert.ok(regions[1].left < regions[2].left, 'then left before right within row 2');
});

test('a horizontal rule is not a photo', () => {
  // Wide but only a few pixels tall — the both-dimensions filter rejects it.
  const px = blankPage();
  for (let y = 200; y < 206; y++) {
    for (let x = 40; x < 600; x++) set(px, x, y, 40, 40, 40);
  }

  assert.deepEqual(detectPhotoRegions(px, W, H), []);
});

test('a small colour chip is not a photo', () => {
  // The red "Incomplete" status square on every row of the reference document.
  const px = blankPage();
  for (let y = 300; y < 312; y++) {
    for (let x = 40; x < 52; x++) set(px, x, y, 220, 40, 40);
  }

  assert.deepEqual(detectPhotoRegions(px, W, H), []);
});

test('a whole page that scanned dark is not reported as one giant photo', () => {
  // Cropping this would hand the reviewer the page back as a "photo".
  const px = blankPage();
  drawPhoto(px, 0, 0, W, H, 11);

  assert.deepEqual(detectPhotoRegions(px, W, H), []);
});

test('a blank page yields nothing', () => {
  assert.deepEqual(detectPhotoRegions(blankPage(), W, H), []);
});

test('a page too small to grid is handled rather than throwing', () => {
  const tiny = new Uint8ClampedArray(20 * 20 * 4).fill(255);
  assert.deepEqual(detectPhotoRegions(tiny, 20, 20), []);
});
