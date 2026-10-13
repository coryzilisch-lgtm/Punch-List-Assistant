import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, guarded, json, readJson, userEmail } from '../lib/http';
import {
  buildPunchItemPayload,
  createPunchItem,
  ProcoreError,
  procoreConfigured,
  PunchItemInput,
  PunchPhoto,
} from '../lib/procore';
import { exhaustedUntil, pushCapacity, currentQuota, quotaReport, WAIT_IN_FUNCTION_MS } from '../lib/quota';

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
   * Gone. This app used to be able to move items out of Draft, which is what
   * emails the manager, the assignees and their companies. On 2026-10-01 one
   * import that ticked it put ~350 emails in front of every sub on a project.
   * Items are now always created as Drafts and the super sends them from
   * Procore. Kept in the type only so a stale page that still sends it is
   * refused, not quietly obeyed or quietly ignored.
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
  /**
   * What Procore actually stored, read back after the write — not what we sent.
   * Both early bugs here were silent successes, so the UI reports this instead.
   */
  observed?: {
    status: string | null;
    workflowLabel: string | null;
    isDraft: boolean | null;
    attachmentCount: number;
    ballInCourt: string[];
    assignees: string[];
    punchItemManager: string | null;
  };
  error?: string;
  /**
   * Refused by the rate limit before anything was written: Procore answers a
   * 429 before doing anything, and an item this push stopped short of was never
   * sent at all. Safe to push again after `resetAt`.
   */
  rateLimited?: boolean;
  /** When the quota resets, epoch ms, on a rate-limited result. */
  resetAt?: number | null;
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

  // The dashboard is served without cache-busting, so a tab opened before this
  // deploy can still post `send: true`. Refuse it before anything is written:
  // creating the items anyway would read to that super as "sent".
  if (body.send) {
    return errorResponse(
      400,
      'Sending from this app has been removed — items are created as Drafts and sent from Procore. Reload the page and push again.',
    );
  }

  // Every item needs a punch item manager. Without one an item has nobody
  // responsible for it on Procore's side, and most tenants reject it anyway;
  // on the 228-item Darden import, 81 items went over with none. Checked for
  // the whole batch before any write, so a stale page cannot create half of it.
  // Dry runs are exempt: a preview writes nothing, and seeing the payload is
  // how a super finds out what is missing.
  if (!dryRun) {
    const unmanaged = body.items.filter((i) => !isProcoreId(i.punchItemManagerId));
    if (unmanaged.length) {
      return errorResponse(
        400,
        `${unmanaged.length} item(s) have no punch item manager. Every item needs one: ` +
          'set it in the bulk card on the review step and push again. Nothing was created.',
      );
    }
  }

  // Refuse a batch the quota cannot carry while leaving the reserve for the
  // Safety Dashboard ingest. Only a KNOWN shortfall refuses: a cold instance
  // has seen no headers yet and goes ahead, and the per-item check below stops
  // it as soon as Procore says the window is spent.
  if (!dryRun) {
    const now = Date.now();
    const capacity = pushCapacity(currentQuota(now), now);
    if (capacity !== null && capacity < body.items.length) {
      return json(
        {
          error:
            capacity === 0
              ? 'Procore\'s rate limit is too close to empty to push anything without starving the Safety Dashboard ingest. Nothing was created.'
              : `Procore's rate limit only has room for ${capacity} more item(s) right now. Nothing was created.`,
          rateLimited: true,
          quota: quotaReport(now),
        },
        429,
      );
    }
  }

  if (!dryRun && !procoreConfigured()) {
    return errorResponse(
      503,
      'Procore is not configured on this deployment. PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET and PROCORE_COMPANY_ID must be set in the app settings.',
    );
  }

  const actor = userEmail(request) || 'unknown';
  const results: PushResult[] = [];

  for (const raw of body.items) {
    // Once Procore has said the window is spent, every later item in this batch
    // would only draw a 429. Stop, and say plainly that they were never sent.
    // A window resetting within seconds is not a stop: procoreRequest waits it
    // out. Only a spent window that resets further out ends the batch.
    const blockedUntil = dryRun ? null : exhaustedUntil(Date.now());
    if (blockedUntil !== null && blockedUntil - Date.now() > WAIT_IN_FUNCTION_MS) {
      results.push({
        clientId: raw.clientId,
        ok: false,
        rateLimited: true,
        resetAt: blockedUntil,
        error: 'Not sent: the Procore rate limit ran out partway through this batch.',
      });
      continue;
    }

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
      const created = await createPunchItem(body.projectId, input, photos);
      const { item, photoErrors, photosAttached, assignErrors, assignStrategy, observed } = created;
      results.push({
        clientId: raw.clientId,
        ok: true,
        punchItemId: item.id,
        punchItemNumber: item.number ?? null,
        photoErrors: photoErrors.length ? photoErrors : undefined,
        photosAttached,
        assignErrors: assignErrors.length ? assignErrors : undefined,
        observed: observed ?? undefined,
      });
      // Log which strategy worked. Once the same one wins across a few real
      // projects, the chains in procore.ts can collapse to it.
      context.log(
        `push ok project=${body.projectId} punch_item=${item.id} by=${actor} ` +
          `photos=${photosAttached}/${photos.length} status=${observed?.status ?? '?'} ` +
          `draft=${observed?.isDraft ?? '?'} ` +
          `assign=${assignStrategy ?? 'none'} bic=${observed?.ballInCourt.join('|') ?? '?'}`,
      );
    } catch (err) {
      if (err instanceof ProcoreError) {
        results.push({
          clientId: raw.clientId,
          ok: false,
          ...(err.status === 429 ? { rateLimited: true, resetAt: err.resetAt } : {}),
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
    quota: quotaReport(Date.now()),
  });
}

function isProcoreId(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
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
  handler: guarded('push', pushHandler),
});
