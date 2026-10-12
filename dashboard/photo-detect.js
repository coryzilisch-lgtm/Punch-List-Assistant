/**
 * Photo detection — pure maths, no DOM.
 *
 * Kept free of any browser API on purpose. The app runs this on a canvas in the
 * browser, the CLI harness in `tools/extract-cli` runs it on a Node-rendered
 * bitmap, and the tests run it on synthetic pixel buffers and operator lists.
 * One implementation, so what a developer verifies offline is what a
 * superintendent gets.
 *
 * Two ways in, tried in this order:
 *  1. `placedImageRegions` — where the PDF itself says it drew each image. Exact,
 *     when the PDF was exported by an app with the photos embedded one by one.
 *  2. `detectPhotoRegions` — a guess from pixels, for scans, where the whole
 *     page is a single image and the PDF has nothing useful to say.
 */

/** Page pixels per grid cell. */
const CELL = 8;

/** A cell counts as photo-like above this score. */
const PHOTO_CELL = 0.45;

/** A photo is at least this fraction of the page wide, and this tall. */
const MIN_W = 0.06;
const MIN_H = 0.045;

/** Anything covering more of the page than this is the page, not a photo on it. */
const WHOLE_PAGE = 0.85;

/**
 * Find the photographs on a rendered page.
 *
 * The distinction that matters is photo vs. text, and the reliable signal is
 * TONE DISTRIBUTION, not darkness. A region of text is overwhelmingly white
 * with a small fraction of near-black pixels; a photograph is mostly mid-tones
 * and usually carries colour. So we score each cell of a coarse grid by the
 * fraction of its pixels that are neither near-white nor near-black, give a
 * boost for colour saturation, and then look for large solid blocks.
 *
 * Rejected alternatives, and why:
 *  - "Dark pixel density" alone: fails on the common punch list photo of a white
 *    wall or a stainless fridge — bright subjects with little dark area.
 *  - Edge detection: a dense table of ruled lines (Excel-style punch lists) is
 *    all edges and would score as one huge photo.
 *  - Trusting the PDF's own embedded image list, ALONE: a scan is one full-page
 *    JPEG per page, so the list is a single object covering the whole page. That
 *    is why this exists; but for an app-exported PDF the list is exact and this
 *    is only a guess, so `placedImageRegions` is asked first.
 *
 * This finds image-shaped regions, which is all pixels can tell you. It cannot
 * tell a defect photo from a header logo or a QR code — that judgement needs to
 * see the page as a document, and happens during extraction.
 *
 * @param {Uint8ClampedArray|Uint8Array} pixels RGBA, 4 bytes per pixel.
 * @param {number} width
 * @param {number} height
 * @returns {Array<{left:number,right:number,top:number,bottom:number}>} normalized 0–1,
 *          in top-to-bottom then left-to-right reading order.
 */
export function detectPhotoRegions(pixels, width, height) {
  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  if (cols < 8 || rows < 8) return [];

  const dense = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let mid = 0;
      let saturated = 0;
      let total = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y += 2) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x += 2) {
          const o = (y * width + x) * 4;
          const r = pixels[o];
          const g = pixels[o + 1];
          const b = pixels[o + 2];
          const max = r > g ? (r > b ? r : b) : g > b ? g : b;
          const min = r < g ? (r < b ? r : b) : g < b ? g : b;
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 42 && lum < 226) mid++;
          if (max - min > 26) saturated++;
          total++;
        }
      }
      // Colour is strong evidence on its own: printed punch lists are greyscale
      // apart from small status chips, which the size filters below discard.
      const score = Math.max(mid / total, (saturated / total) * 1.4);
      dense[cy * cols + cx] = score >= PHOTO_CELL ? 1 : 0;
    }
  }

  const minCells = Math.max(24, Math.round(cols * rows * 0.004));
  const out = [];

  for (const box of connectedBoxes(openGrid(dense, cols, rows), cols, rows)) {
    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;
    if (box.count < minCells) continue;
    // A photo is a solid rectangle. A run of text or a table border traced by the
    // grid is a sparse skeleton inside its bounding box, so fill ratio separates
    // them cleanly.
    if (box.count / (bw * bh) < 0.62) continue;
    // Must be meaningfully large in BOTH directions — this is what rejects a
    // horizontal rule, a coloured status chip, or a logo strip.
    if (bw / cols < MIN_W || bh / rows < MIN_H) continue;
    // Nothing on a punch list is a photo of the whole page. A hit this large
    // means the page itself is a dark scan, and cropping it would produce a
    // "photo" that is just the page again.
    if ((bw * bh) / (cols * rows) > WHOLE_PAGE) continue;

    out.push({
      left: box.x0 / cols,
      right: (box.x1 + 1) / cols,
      top: box.y0 / rows,
      bottom: (box.y1 + 1) / rows,
    });
  }

  return readingOrder(out);
}

/**
 * Where the PDF painted its images, from the page's pdf.js operator list.
 *
 * An app-exported punch list (the Darden walkthrough is one) embeds every photo
 * as its own image and places it with a transform, so the page says exactly
 * where each photo is. The pixel detector cannot match that: it reads near-white
 * as paper, so a photo of a white wall, a bright sky or a stainless counter is
 * split in two or lost, and a divider rule drawn flush against a photo used to
 * swallow it outright. On that document pixels found 74 of 228 photos.
 *
 * Returns null whenever the PDF cannot answer, so the caller falls back to
 * pixels: a page carrying an image that covers most of it (a scan), or a page
 * with no image big enough to be a photo.
 *
 * @param {{fnArray: number[], argsArray: any[]}} opList from `page.getOperatorList()`
 * @param {Record<string, number>} OPS pdf.js's `OPS` table, passed in so this file imports nothing
 * @param {number[]} transform the viewport's `transform`: PDF user space to device pixels
 * @param {number} width viewport width in device pixels
 * @param {number} height viewport height in device pixels
 * @returns {Array<{left:number,right:number,top:number,bottom:number}>|null}
 */
export function placedImageRegions(opList, OPS, transform, width, height) {
  const { fnArray, argsArray } = opList;
  const stack = [];
  let ctm = transform.slice();
  // Images inside an annotation (a stamp, a form field's appearance) are not
  // the document's photos, and the annotation's own transform rules are not
  // worth reproducing to find them.
  let inAnnotation = 0;
  const boxes = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.transform:
        ctm = multiply(ctm, args);
        break;
      // pdf.js paints a form inside save/restore with its matrix applied, and
      // paints a transparency group with the transform it was entered with.
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = multiply(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        break;
      case OPS.endGroup:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.beginAnnotation:
        inAnnotation++;
        break;
      case OPS.endAnnotation:
        if (inAnnotation) inAnnotation--;
        break;
      // An image is drawn into the unit square of the current transform.
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        if (!inAnnotation) boxes.push(unitSquareBox(ctm, width, height));
        break;
    }
  }

  // A scan: the page is one picture, and where it sits says nothing.
  if (boxes.some((b) => (b.right - b.left) * (b.bottom - b.top) > WHOLE_PAGE)) return null;

  // Same size floor as the pixel path, so a logo, an icon or a status chip is
  // no more a photo here than it is there.
  const kept = mergeTouching(boxes.filter((b) => b.right - b.left >= MIN_W && b.bottom - b.top >= MIN_H));
  if (!kept.length) return null;
  return readingOrder(kept);
}

/** Box of the unit square under a transform, normalized and clamped to the page. */
function unitSquareBox(m, width, height) {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return {
    left: clamp(Math.min(...xs) / width),
    right: clamp(Math.max(...xs) / width),
    top: clamp(Math.min(...ys) / height),
    bottom: clamp(Math.max(...ys) / height),
  };
}

/** `m1 × m2` in PDF's [a b c d e f] form; the same product pdf.js's `Util.transform` computes. */
function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Union boxes that overlap or touch. Some exporters slice one large photo into
 * strips, and some paint the same image twice; either way it is one photo to
 * the superintendent, and would be one region to the pixel detector too.
 */
function mergeTouching(boxes) {
  const EPS = 0.002;
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (
          a.left <= b.right + EPS &&
          b.left <= a.right + EPS &&
          a.top <= b.bottom + EPS &&
          b.top <= a.bottom + EPS
        ) {
          a.left = Math.min(a.left, b.left);
          a.right = Math.max(a.right, b.right);
          a.top = Math.min(a.top, b.top);
          a.bottom = Math.max(a.bottom, b.bottom);
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Reading order: top to bottom, then left to right. The extraction prompt tells
 * Claude the photos are numbered in this order, so it must hold. Rows are
 * bucketed before sorting horizontally, otherwise two photos side by side with
 * a few pixels of vertical offset would sort as two separate rows.
 */
function readingOrder(regions) {
  const ROW_GAP = 0.04;
  return regions.sort((a, b) => {
    if (Math.abs(a.top - b.top) > ROW_GAP) return a.top - b.top;
    return a.left - b.left;
  });
}

/**
 * Morphological opening with a 3x3 block: keep only cells that sit inside a
 * solid 3x3, then grow the survivors back by one cell.
 *
 * This cuts lines one or two cells thick away from anything they touch. Without
 * it, a divider rule drawn flush against a photo's edge (the Darden walkthrough
 * puts one on top of every photo) joins the photo into a single page-wide blob
 * that is mostly empty, and the fill-ratio check below discards the photo along
 * with the rule. A solid rectangle comes back exactly as it was. Opening only
 * ever removes cells, so it cannot invent a photo.
 */
function openGrid(dense, cols, rows) {
  const at = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && dense[y * cols + x] === 1;

  const core = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!dense[y * cols + x]) continue;
      let solid = true;
      for (let dy = -1; dy <= 1 && solid; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!at(x + dx, y + dy)) {
            solid = false;
            break;
          }
        }
      }
      if (solid) core[y * cols + x] = 1;
    }
  }

  const opened = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!core[y * cols + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) opened[ny * cols + nx] = 1;
        }
      }
    }
  }
  return opened;
}

/** Label connected cells (4-connectivity) and return each blob's bounding box. */
function connectedBoxes(dense, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  const stack = new Int32Array(cols * rows);

  for (let start = 0; start < dense.length; start++) {
    if (!dense[start] || seen[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;

    let x0 = cols;
    let x1 = -1;
    let y0 = rows;
    let y1 = -1;
    let count = 0;

    const push = (n) => {
      if (dense[n] && !seen[n]) {
        seen[n] = 1;
        stack[sp++] = n;
      }
    };

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % cols;
      const y = (idx - x) / cols;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      if (x > 0) push(idx - 1);
      if (x < cols - 1) push(idx + 1);
      if (y > 0) push(idx - cols);
      if (y < rows - 1) push(idx + cols);
    }

    boxes.push({ x0, x1, y0, y1, count });
  }

  return boxes;
}
