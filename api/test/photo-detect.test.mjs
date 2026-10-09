import test from 'node:test';
import assert from 'node:assert/strict';

// The detector is shared with the browser, so the test imports it from where it
// lives rather than from a copy. `npm test` runs from api/, which is why the
// path climbs out.
import { detectPhotoRegions, placedImageRegions } from '../../dashboard/photo-detect.js';

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

test('a photo whose edge touches a divider rule is still found', () => {
  // The Darden "Operations Punch Walkthrough" layout: every issue row opens with
  // a red rule running the width of the page, and the photo hangs directly off
  // it. On the grid the rule and the photo were one blob, a full-width box that
  // was mostly empty, so the fill-ratio check threw the photo out with the rule.
  // 154 of 228 photos in that document went missing this way.
  const px = blankPage();
  const rows = [
    { top: 60, bottom: 250, left: 60 },
    { top: 300, bottom: 490, left: 110 }, // inset, as portrait photos are there
    { top: 540, bottom: 730, left: 60 },
  ];
  for (const [i, r] of rows.entries()) {
    // Three rule thicknesses, so the rule lands on the grid every way it can.
    for (let y = r.top - 2 - i; y < r.top; y++) {
      for (let x = 60; x < 600; x++) set(px, x, y, 210, 60, 60);
    }
    drawPhoto(px, r.left, r.top, 250, r.bottom, 20 + i);
  }

  const regions = detectPhotoRegions(px, W, H);

  assert.equal(regions.length, 3, `found ${JSON.stringify(regions)}`);
  for (const [i, r] of rows.entries()) {
    assert.ok(
      within(regions[i], { top: r.top / H, bottom: r.bottom / H, left: r.left / W, right: 250 / W }, 0.02),
      `photo ${i} was ${JSON.stringify(regions[i])}`,
    );
  }
});

// ── Placed images: where the PDF itself drew each photo ─────────────────────

/** The subset of pdf.js's OPS table the locator reads. Values match pdf.js 4.10. */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  beginAnnotation: 80,
  endAnnotation: 81,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
};

/** A US Letter page at scale 1: PDF space is y-up, the viewport flips it. */
const PW = 612;
const PH = 792;
const VIEWPORT = [1, 0, 0, -1, 0, PH];

/** Build an operator list from [op, args] pairs. */
const ops = (...pairs) => ({ fnArray: pairs.map((p) => p[0]), argsArray: pairs.map((p) => p[1] ?? null) });

/** `q  w 0 0 h x y cm  /Im Do  Q` — how an exporter places one photo. y is the BOTTOM edge, PDF-style. */
const placed = (x, y, w, h) => [
  [OPS.save],
  [OPS.transform, [w, 0, 0, h, x, y]],
  [OPS.paintImageXObject, ['img']],
  [OPS.restore],
];

const near = (a, b) => Math.abs(a - b) < 1e-6;

test('placed photos are located exactly, in reading order', () => {
  // The Darden walkthrough: four photos stacked down the left of the page.
  const list = ops(
    ...placed(84, 400, 104, 139), // painted first, but lower on the page
    ...placed(50, 702, 500, 3), // a divider rule drawn as an image: too thin to be a photo
    ...placed(50, 590, 139, 104),
  );

  const regions = placedImageRegions(list, OPS, VIEWPORT, PW, PH);

  assert.equal(regions.length, 2);
  assert.ok(regions[0].top < regions[1].top, 'top of the page first');
  const lower = regions[1];
  assert.ok(near(lower.left, 84 / PW) && near(lower.right, 188 / PW), JSON.stringify(lower));
  assert.ok(near(lower.top, (PH - 539) / PH) && near(lower.bottom, (PH - 400) / PH), JSON.stringify(lower));
});

test('a scan, one image covering the page, defers to the pixel detector', () => {
  const list = ops(...placed(0, 0, PW, PH));
  assert.equal(placedImageRegions(list, OPS, VIEWPORT, PW, PH), null);
});

test('a page with no photo-sized image defers to the pixel detector', () => {
  // A logo in the corner and nothing else: the pixels may still know something.
  assert.equal(placedImageRegions(ops(...placed(20, 740, 30, 30)), OPS, VIEWPORT, PW, PH), null);
  assert.equal(placedImageRegions(ops(), OPS, VIEWPORT, PW, PH), null);
});

test('a form XObject matrix applies inside the form and is undone after it', () => {
  const list = ops(
    [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 300, 0], [0, 0, 612, 792]]],
    ...placed(0, 400, 200, 150), // drawn at x=300 because of the form matrix
    [OPS.paintFormXObjectEnd],
    ...placed(0, 100, 200, 150), // back at x=0
  );

  const regions = placedImageRegions(list, OPS, VIEWPORT, PW, PH);

  assert.equal(regions.length, 2);
  assert.ok(near(regions[0].left, 300 / PW), `form photo at ${regions[0].left}`);
  assert.ok(near(regions[1].left, 0), `photo after the form at ${regions[1].left}`);
});

test('a transparency group does not move what is painted inside it', () => {
  const list = ops(
    [OPS.beginGroup, [{ matrix: [1, 0, 0, 1, 250, 0], bbox: [0, 0, 612, 792] }]],
    ...placed(40, 400, 200, 150),
    [OPS.endGroup, [{}]],
  );

  const [region] = placedImageRegions(list, OPS, VIEWPORT, PW, PH);

  // pdf.js paints group content with the transform the group was entered with;
  // the group matrix only sizes its scratch canvas.
  assert.ok(near(region.left, 40 / PW), `group photo at ${region.left}`);
});

test('a photo exported as strips is one photo', () => {
  const list = ops(...placed(100, 400, 200, 50), ...placed(100, 450, 200, 50), ...placed(100, 500, 200, 50));

  const regions = placedImageRegions(list, OPS, VIEWPORT, PW, PH);

  assert.equal(regions.length, 1);
  assert.ok(near(regions[0].top, (PH - 550) / PH) && near(regions[0].bottom, (PH - 400) / PH));
});

test('two photos a normal gap apart are not merged', () => {
  const list = ops(...placed(84, 573, 104, 139), ...placed(84, 410, 104, 139));
  assert.equal(placedImageRegions(list, OPS, VIEWPORT, PW, PH).length, 2);
});

test('an image inside an annotation is not a photo on the page', () => {
  const list = ops(
    [OPS.beginAnnotation, ['a1', [0, 0, 612, 792], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], false]],
    ...placed(100, 400, 200, 150),
    [OPS.endAnnotation],
  );
  assert.equal(placedImageRegions(list, OPS, VIEWPORT, PW, PH), null);
});
