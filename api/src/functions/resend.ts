import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, guarded, json, readJson, userEmail } from '../lib/http';
import { observePunchItem, procoreConfigured, sendPunchItem } from '../lib/procore';

/**
 * POST /api/resend — send punch items that were created but never left Draft.
 *
 * This exists because of a real push. Six items sent cleanly, then Procore rate
 * limited the seventh — the service account is shared with the Safety Dashboard
 * ingest — and the rest were created with their photos and assignees intact and
 * simply never sent. The work was all there. The only thing missing was one call
 * per item, and without this the only way to recover was to push the whole list
 * again and create sixty duplicates.
 *
 * So: nothing is created here. It takes ids that already exist and finishes the
 * job, which makes a rate limit an inconvenience instead of a mess to clean up.
 */

interface ResendBody {
  projectId: number;
  punchItemIds: number[];
}

/**
 * Smaller than the push batch. Each item costs a read, a write and a verifying
 * read, and this runs when the quota is already under pressure — that is the
 * situation it was built for.
 */
const MAX_BATCH = 8;

export async function resendHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!procoreConfigured()) {
    return errorResponse(503, 'Procore is not configured on this deployment.');
  }

  const body = await readJson<ResendBody>(request);
  if (!body?.projectId || !Array.isArray(body.punchItemIds) || !body.punchItemIds.length) {
    return errorResponse(400, 'Send projectId and a punchItemIds array.');
  }

  const ids = body.punchItemIds
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0)
    .slice(0, MAX_BATCH);
  if (!ids.length) return errorResponse(400, 'No valid punch item ids.');

  const actor = userEmail(request) || 'unknown';
  const results = [];

  for (const punchItemId of ids) {
    try {
      const before = await observePunchItem(body.projectId, punchItemId);

      // Already out of Draft — someone sent it in Procore, or an earlier retry
      // landed. Report it as done rather than writing to it again.
      if (before?.isDraft === false) {
        results.push({ punchItemId, ok: true, alreadySent: true, observed: before });
        continue;
      }

      const sent = await sendPunchItem(body.projectId, punchItemId, before);
      results.push({
        punchItemId,
        ok: sent.sent,
        alreadySent: false,
        errors: sent.errors.length ? sent.errors : undefined,
        observed: sent.observed ?? before,
      });
      context.log(
        `resend project=${body.projectId} punch_item=${punchItemId} by=${actor} ` +
          `sent=${sent.sent} via=${sent.strategy ?? 'none'}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ punchItemId, ok: false, alreadySent: false, errors: [message] });
      context.error(`resend failed project=${body.projectId} punch_item=${punchItemId}: ${message}`);
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return json({
    projectId: body.projectId,
    sent,
    failed: results.length - sent,
    remaining: Math.max(0, body.punchItemIds.length - ids.length),
    results,
  });
}

app.http('resend', {
  methods: ['POST'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'resend',
  handler: guarded('resend', resendHandler),
});
