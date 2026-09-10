import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, json, readJson, userEmail } from '../lib/http';
import {
  buildPunchItemPayload,
  createPunchItem,
  ProcoreError,
  procoreConfigured,
  PunchItemInput,
  PunchPhoto,
} from '../lib/procore';

/**
 * POST /api/push — create a batch of punch items in Procore.
 *
 * Batched rather than all-at-once for the same reason extraction is
 * page-at-a-time: the 45-second SWA Function ceiling. The client walks the
 * approved list in small batches and shows progress. Each item reports its own
 * outcome, so a partial failure leaves a precise list of what still needs to go
 * over instead of an all-or-nothing error.
 */

interface PushItemBody {
  /** Client-side row id, echoed back so the UI can match results to rows. */
  clientId: string;
  name: string;
  description?: string | null;
  priority?: 'low' | 'medium' | 'high' | null;
  dueDate?: string | null;
  punchItemTypeId?: number | null;
  locationId?: number | null;
  tradeId?: number | null;
  punchItemManagerId?: number | null;
  finalApproverId?: number | null;
  assigneeIds?: number[];
  vendorId?: number | null;
  reference?: string | null;
  /** data: URLs of the photos cropped from the source document. */
  photos?: string[];
}

interface PushBody {
  projectId: number;
  dryRun?: boolean;
  /**
   * Move each created item out of Draft. Off by default: sending is what
   * notifies the punch item manager and assignees, and a silent send of sixty
   * items would email people who never agreed to receive them.
   */
  send?: boolean;
  items: PushItemBody[];
}

const MAX_BATCH = 10;

interface PushResult {
  clientId: string;
  ok: boolean;
  punchItemId?: number;
  punchItemNumber?: string | number | null;
  /** Photos that failed to attach even though the item itself was created. */
  photoErrors?: string[];
  photosAttached?: number;
  /** Assignment attempts that failed, when the requested assignee did not stick. */
  assignErrors?: string[];
  /** Failures moving the item out of Draft, when sending was requested. */
  sendErrors?: string[];
  /**
   * What Procore actually stored, read back after the write — not what we sent.
   * Both early bugs here were silent successes, so the UI reports this instead.
   */
  observed?: {
    status: string | null;
    attachmentCount: number;
    ballInCourt: string[];
    assignees: string[];
    punchItemManager: string | null;
  };
  error?: string;
  /** Field-level messages straight from Procore, when it gave any. */
  fieldErrors?: string[];
  /** Present on dry runs: the exact body that would be sent. */
  payload?: Record<string, unknown>;
}

export async function pushHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let body: PushBody;
  try {
    body = await readJson<PushBody>(request);
  } catch (err) {
    return errorResponse(400, String(err instanceof Error ? err.message : err));
  }

  if (!body.projectId) return errorResponse(400, 'projectId is required.');
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse(400, 'No items were supplied.');
  }
  if (body.items.length > MAX_BATCH) {
    return errorResponse(
      400,
      `Send at most ${MAX_BATCH} items per request so the batch finishes inside the 45-second function limit.`,
    );
  }

  const dryRun = Boolean(body.dryRun);

  if (!dryRun && !procoreConfigured()) {
    return errorResponse(
      503,
      'Procore is not configured on this deployment. PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET and PROCORE_COMPANY_ID must be set in the app settings.',
    );
  }

  const actor = userEmail(request) || 'unknown';
  const results: PushResult[] = [];

  for (const raw of body.items) {
    const name = (raw.name || '').trim();
    if (!name) {
      results.push({
        clientId: raw.clientId,
        ok: false,
        error: 'Item has no description text, so there is nothing to create.',
      });
      continue;
    }

    const input: PunchItemInput = {
      name,
      description: raw.description || undefined,
      priority: raw.priority ?? null,
      dueDate: raw.dueDate ?? null,
      punchItemTypeId: raw.punchItemTypeId ?? null,
      locationId: raw.locationId ?? null,
      tradeId: raw.tradeId ?? null,
      punchItemManagerId: raw.punchItemManagerId ?? null,
      finalApproverId: raw.finalApproverId ?? null,
      assigneeIds: raw.assigneeIds || [],
      vendorId: raw.vendorId ?? null,
      reference: raw.reference ?? null,
    };

    if (dryRun) {
      results.push({
        clientId: raw.clientId,
        ok: true,
        payload: {
          project_id: body.projectId,
          punch_item: buildPunchItemPayload(input),
          attachments: (raw.photos || []).length,
        },
      });
      continue;
    }

    let photos: PunchPhoto[];
    try {
      photos = (raw.photos || []).map((p, i) => decodePhoto(p, `${slug(name)}-${i + 1}`));
    } catch (err) {
      results.push({
        clientId: raw.clientId,
        ok: false,
        error: `Photo could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      const created = await createPunchItem(body.projectId, input, photos, {
        send: Boolean(body.send),
      });
      const { item, photoErrors, photosAttached, assignErrors, assignStrategy, sendErrors, observed } =
        created;
      results.push({
        clientId: raw.clientId,
        ok: true,
        punchItemId: item.id,
        punchItemNumber: item.number ?? null,
        photoErrors: photoErrors.length ? photoErrors : undefined,
        photosAttached,
        assignErrors: assignErrors.length ? assignErrors : undefined,
        sendErrors: sendErrors.length ? sendErrors : undefined,
        observed: observed ?? undefined,
      });
      // Log which strategy worked. Once the same one wins across a few real
      // projects, the chains in procore.ts can collapse to it.
      context.log(
        `push ok project=${body.projectId} punch_item=${item.id} by=${actor} ` +
          `photos=${photosAttached}/${photos.length} status=${observed?.status ?? '?'} ` +
          `assign=${assignStrategy ?? 'none'} bic=${observed?.ballInCourt.join('|') ?? '?'}`,
      );
    } catch (err) {
      if (err instanceof ProcoreError) {
        results.push({
          clientId: raw.clientId,
          ok: false,
          error: `Procore rejected this item (HTTP ${err.status}).`,
          // Surfaced verbatim: which fields a tenant requires is configuration,
          // not something this code can know ahead of time. Showing Procore's
          // own message is what turns a failed push into a fixable one.
          fieldErrors: err.fieldErrors(),
        });
        context.error(`push failed project=${body.projectId} status=${err.status} body=${JSON.stringify(err.body)}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ clientId: raw.clientId, ok: false, error: message });
        context.error(`push failed project=${body.projectId}: ${message}`);
      }
    }
  }

  const created = results.filter((r) => r.ok).length;
  return json({
    dryRun,
    projectId: body.projectId,
    created,
    failed: results.length - created,
    results,
  });
}

function decodePhoto(dataUrl: string, baseName: string): PunchPhoto {
  const match = /^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error('expected an image data URL');
  const mediaType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const ext = mediaType.split('/')[1];
  return {
    filename: `${baseName}.${ext}`,
    contentType: mediaType,
    bytes: Buffer.from(match[3], 'base64'),
  };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'punch-item'
  );
}

app.http('push', {
  methods: ['POST'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'push',
  handler: pushHandler,
});
