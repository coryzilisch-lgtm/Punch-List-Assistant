import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import { aiConfigured, messagesApi, modelId } from './model';

/**
 * Punch list extraction.
 *
 * Every owner sends a different document. The Darden example that drove this
 * build is an export from the "Punch List" iOS app: a rigid three-issues-per-page
 * layout with labelled fields. But Chick-fil-A, a hospital owner, and an
 * architect's walkthrough will each send something else — a Word table, an Excel
 * print, a numbered list, a marked-up photo report. So the prompt describes the
 * SHAPE OF THE DATA we want, not the shape of any one document, and the schema
 * keeps every field optional except the one thing every punch list has: a
 * description of what is wrong.
 *
 * The page image arrives already rendered by the browser (see dashboard/app.js).
 * Rendering client-side keeps pdf.js and its native canvas dependency out of the
 * Function, which matters: SWA managed Functions cap a deployment at ~15,000
 * files and cannot install system packages.
 *
 * Which Claude endpoint this runs against — Buffalo's Azure AI Foundry resource
 * in production, the direct API in local development — is decided in `model.ts`.
 * Both expose the same `messages` resource, so nothing here changes with it.
 */

/**
 * Reasoning effort. This is a LATENCY control, not a cost decision: SWA managed
 * Functions hard-stop a request at 45 seconds, and a dense page at full effort
 * can run past that — which the super would see as a failed page, not a slow one.
 * Medium keeps a page comfortably inside the window. Raise it to "high" if a
 * particular owner's documents read poorly and you move extraction somewhere
 * without the 45s ceiling.
 */
const EFFORT = (process.env.PUNCH_EXTRACT_EFFORT || 'medium') as
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** One photo the browser cropped out of the page, described by position. */
export interface PhotoRegion {
  /** Index into the page's photo array, in top-to-bottom reading order. */
  index: number;
  /** Normalized 0–1 position on the page, used for the pairing fallback. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const ItemSchema = z.object({
  source_number: z
    .string()
    .nullable()
    .describe("The item's own number in the source document, exactly as printed. Null if unnumbered."),
  title: z
    .string()
    .describe(
      "The defect itself, transcribed verbatim from the document. This becomes the punch item's name in Procore.",
    ),
  description: z
    .string()
    .nullable()
    .describe('Any additional comment, note, or detail beyond the title. Null if there is none.'),
  location: z
    .string()
    .nullable()
    .describe('Area/floor/zone the item is in, e.g. "Kitchen", "Mechanical", "Vestibule". Null if absent.'),
  room: z.string().nullable().describe('Room name or number, when given separately from the area.'),
  sheet: z.string().nullable().describe('Drawing or sheet reference, when given.'),
  status: z.string().nullable().describe('Status as printed, e.g. "Incomplete", "Open", "Complete".'),
  assignee: z
    .string()
    .nullable()
    .describe('Person, trade, or company the item is assigned to, as printed. Null if blank.'),
  due_date: z
    .string()
    .nullable()
    .describe('Due or resolution date as an ISO YYYY-MM-DD string, if one is printed. Null otherwise.'),
  trade_guess: z
    .string()
    .nullable()
    .describe(
      'Your INFERENCE of the responsible trade (e.g. "Plumbing", "Electrical", "Drywall", "Painting"), based on the defect described. Null when the defect does not clearly imply one trade. This is a suggestion for a human to confirm, never a transcription.',
    ),
  photo_indexes: z
    .array(z.number())
    .describe(
      'Indexes of the photos on this page that belong to this item, from the numbered photo list given to you. Empty array if none.',
    ),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'high = the text is clearly legible and unambiguous. medium = readable but some fields uncertain. low = handwriting, poor scan, or ambiguous layout; a human should check this row.',
    ),
});

const PageSchema = z.object({
  page_kind: z
    .enum(['items', 'cover', 'other'])
    .describe(
      '"items" if this page contains punch list entries. "cover" for a title/cover/signature/instructions page. "other" for anything else with no punch items.',
    ),
  items: z.array(ItemSchema).describe('Every punch list item on this page, in top-to-bottom order.'),
  page_furniture_photo_indexes: z
    .array(z.number())
    .describe(
      'Indexes of detected photo regions that are NOT documentation of a defect — a company logo, a building photo in the page header, a QR code, an app-store badge, a signature block, a map. These are discarded and never attached to an item.',
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      'Anything a human should know about this page — an item split across the page break, an unreadable region, a column you could not interpret. Null if the page read cleanly.',
    ),
});

export type ExtractedItem = z.infer<typeof ItemSchema>;
export type ExtractedPage = z.infer<typeof PageSchema>;

const SYSTEM = `You transcribe construction punch lists into structured data.

A punch list is the owner's or architect's list of defects and unfinished work that a general contractor must correct before a project closes out. Each entry names something wrong in a specific place. Your output is imported into Procore, where a superintendent assigns each entry to a subcontractor.

Source documents vary enormously: exports from punch list apps with labelled fields, Word or Excel tables, numbered lists in a letter, handwritten walkthrough notes, or photo reports with captions. Read whatever you are given on its own terms rather than expecting a particular layout.

Rules:

1. TRANSCRIBE, DO NOT AUTHOR. The title must be the defect as written in the document. Do not reword, expand, correct grammar, or make an item sound more professional. A superintendent has to recognize this row when the owner asks about it, and the owner's wording is what they will use. "Seal all holes" stays "Seal all holes".

2. NEVER INVENT AN ITEM. If the page has no punch items, return an empty items array with the right page_kind. An imagined item costs a subcontractor a trip to the site.

3. LEAVE FIELDS NULL WHEN BLANK. These documents are full of empty labelled fields — a printed "Assign To" or "Comment" heading with nothing under it means null, not a guess and not the label text itself.

4. ONE ENTRY PER DEFECT. If a single numbered entry lists several distinct defects, keep it as one item and preserve the full text; do not split it. Splitting changes the owner's numbering, which both sides track against.

5. SEPARATE INFERENCE FROM TRANSCRIPTION. Only trade_guess may be inferred. Every other field must come off the page.

6. FLAG WHAT YOU ARE UNSURE OF. Set confidence to low and explain in notes rather than producing a confident wrong reading. A flagged row gets fixed in ten seconds; a silently wrong row reaches a subcontractor.

7. WATCH THE PAGE BOUNDARY. If an item is cut off at the top or bottom of the page, still return what is visible and say so in notes.`;

export interface ExtractPageArgs {
  /** Base64 page image, no data: prefix. */
  imageBase64: string;
  imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  pageNumber: number;
  totalPages: number;
  photos: PhotoRegion[];
}

export interface ExtractPageResult extends ExtractedPage {
  pageNumber: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function extractPage(args: ExtractPageArgs): Promise<ExtractPageResult> {
  const { imageBase64, imageMediaType, pageNumber, totalPages, photos } = args;

  const photoList = photos.length
    ? photos
        .map(
          (p) =>
            `  [${p.index}] occupies the region from ${pct(p.top)} to ${pct(p.bottom)} down the page, ` +
            `and ${pct(p.left)} to ${pct(p.right)} across.`,
        )
        .join('\n')
    : '  (none detected on this page)';

  const userText = `This is page ${pageNumber} of ${totalPages} of a punch list document.

Photos detected on this page, numbered in top-to-bottom reading order:
${photoList}

These regions were found by a shape detector that cannot tell a defect photo from a logo, so check each one against what you see on the page.

Assign each photo that documents a defect to its item using photo_indexes. Punch list layouts put an item's photos on the same row as its text, so match by vertical position: a photo belongs to the item whose text sits at the same height. Use each photo index at most once, and leave photo_indexes empty for items with no photo.

List any region that is page furniture rather than a defect photo in page_furniture_photo_indexes — headers, logos, building photos, QR codes, app-store badges, signature blocks. Every region must appear in exactly one of the two lists, so that nothing is silently attached to the wrong item.

Return every punch list item on this page.`;

  const response = await messagesApi().parse({
    model: modelId(),
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: imageMediaType, data: imageBase64 },
          },
          { type: 'text', text: userText },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(PageSchema), effort: EFFORT },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(`Extraction returned no parsable output for page ${pageNumber}`);
  }

  return {
    ...parsed,
    items: assignOrphanPhotos(parsed.items, photos, parsed.page_furniture_photo_indexes || []),
    pageNumber,
    model: modelId(),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
  };
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Repair photo assignment.
 *
 * Two failure modes to clean up, both of which would otherwise put a photo on
 * the wrong punch item — worse than no photo, because it sends a sub to look at
 * the wrong thing:
 *
 *  - A photo claimed by more than one item, or an index that does not exist.
 *    Drop the duplicates/strays.
 *  - A photo claimed by nobody. Assign it by vertical overlap with the items
 *    around it. Both lists are in top-to-bottom order, so position is the same
 *    signal a person uses reading the page.
 *
 * Regions the model identified as page furniture are excluded from BOTH passes.
 * The shape detector cannot distinguish a defect photo from the restaurant photo
 * in a page header or the app-store QR code in a footer — it finds all three, and
 * on the reference document it does. Without this exclusion the orphan pass would
 * dutifully staple the header logo onto the first punch item of every page.
 */
export function assignOrphanPhotos(
  items: ExtractedItem[],
  photos: PhotoRegion[],
  furnitureIndexes: number[],
): ExtractedItem[] {
  const furniture = new Set(furnitureIndexes);
  const usable = photos.filter((p) => !furniture.has(p.index));
  if (!usable.length) return items.map((i) => ({ ...i, photo_indexes: [] }));

  const valid = new Set(usable.map((p) => p.index));
  const claimed = new Set<number>();

  const cleaned = items.map((item) => {
    const kept: number[] = [];
    for (const idx of item.photo_indexes || []) {
      if (valid.has(idx) && !claimed.has(idx)) {
        claimed.add(idx);
        kept.push(idx);
      }
    }
    return { ...item, photo_indexes: kept };
  });

  const orphans = usable.filter((p) => !claimed.has(p.index));
  if (!orphans.length || !cleaned.length) return cleaned;

  // Approximate each item's vertical band from the photos it already owns.
  // Items that own nothing get a band interpolated from their ordinal position,
  // which is what makes this work on the common case: a page where the model
  // returned items in order but assigned no photos at all.
  const bands = cleaned.map((item, i) => {
    const owned = (item.photo_indexes || [])
      .map((idx) => usable.find((p) => p.index === idx))
      .filter((p): p is PhotoRegion => Boolean(p));
    if (owned.length) {
      return {
        center: (Math.min(...owned.map((p) => p.top)) + Math.max(...owned.map((p) => p.bottom))) / 2,
        i,
      };
    }
    return { center: (i + 0.5) / cleaned.length, i };
  });

  for (const orphan of orphans) {
    const center = (orphan.top + orphan.bottom) / 2;
    let best = bands[0];
    for (const band of bands) {
      if (Math.abs(band.center - center) < Math.abs(best.center - center)) best = band;
    }
    cleaned[best.i].photo_indexes.push(orphan.index);
  }

  for (const item of cleaned) item.photo_indexes.sort((a, b) => a - b);
  return cleaned;
}

export function extractionConfigured(): boolean {
  return aiConfigured();
}

export function extractionModel(): string {
  return modelId();
}
