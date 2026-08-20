import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, json, readJson, userEmail } from '../lib/http';
import { extractPage, extractionConfigured, extractionModel, PhotoRegion } from '../lib/extract';

/**
 * POST /api/extract — read ONE page of a punch list document.
 *
 * One page per request on purpose. SWA managed Functions hard-stop at 45
 * seconds, so a whole 17-page document in a single call would time out and lose
 * the work. Page-at-a-time also lets the UI show real progress and lets a single
 * failed page be retried without re-reading the other sixteen.
 */

interface ExtractBody {
  pageNumber: number;
  totalPages: number;
  /** data: URL or bare base64 of the rendered page. */
  image: string;
  photos?: PhotoRegion[];
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function extractHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!extractionConfigured()) {
    return errorResponse(
      503,
      'Document reading is not configured on this deployment. ANTHROPIC_API_KEY is missing from the app settings.',
    );
  }

  let body: ExtractBody;
  try {
    body = await readJson<ExtractBody>(request);
  } catch (err) {
    return errorResponse(400, String(err instanceof Error ? err.message : err));
  }

  if (!body.image) return errorResponse(400, 'No page image was supplied.');
  if (!body.pageNumber || body.pageNumber < 1) return errorResponse(400, 'pageNumber must be 1 or greater.');

  const decoded = decodeImage(body.image);
  if (!decoded) {
    return errorResponse(400, 'Page image was not a recognizable PNG, JPEG or WebP data URL.');
  }
  if (decoded.base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return errorResponse(
      413,
      'Page image is too large. Render pages at a lower scale — 150 DPI is plenty for reading punch list text.',
    );
  }

  const started = Date.now();
  try {
    const result = await extractPage({
      imageBase64: decoded.base64,
      imageMediaType: decoded.mediaType,
      pageNumber: body.pageNumber,
      totalPages: body.totalPages || body.pageNumber,
      photos: body.photos || [],
    });

    context.log(
      `extract page=${body.pageNumber} items=${result.items.length} ` +
        `kind=${result.page_kind} ms=${Date.now() - started} user=${userEmail(request) || 'unknown'}`,
    );

    return json({ ...result, elapsedMs: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(`extract page=${body.pageNumber} failed: ${message}`);
    // The page number travels back with the error so the UI can mark exactly
    // which page needs a retry rather than failing the whole document.
    return errorResponse(502, `Could not read page ${body.pageNumber}: ${message}`, {
      pageNumber: body.pageNumber,
      model: extractionModel(),
    });
  }
}

function decodeImage(
  input: string,
): { base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | null {
  const match = /^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i.exec(input.trim());
  if (match) {
    const raw = match[1].toLowerCase();
    const mediaType = raw === 'image/jpg' ? 'image/jpeg' : (raw as 'image/png' | 'image/jpeg' | 'image/webp');
    return { base64: match[3], mediaType };
  }
  // Bare base64 — sniff the magic bytes rather than assuming a type.
  const head = Buffer.from(input.slice(0, 32), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50) return { base64: input, mediaType: 'image/png' };
  if (head[0] === 0xff && head[1] === 0xd8) return { base64: input, mediaType: 'image/jpeg' };
  return null;
}

app.http('extract', {
  methods: ['POST'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'extract',
  handler: extractHandler,
});
