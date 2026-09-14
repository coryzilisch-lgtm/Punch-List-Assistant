import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, guarded, json } from '../lib/http';
import { isUnsentImport, listPunchItems, procoreConfigured, serviceAccountId } from '../lib/procore';

/**
 * GET /api/drafts?project_id=123 — imports that were created but never sent.
 *
 * The results screen can already retry a send, but only for the push that is
 * still on screen. Close the tab after a push Procore rate limited partway
 * through and the unsent items become invisible to the app: they are in Procore,
 * complete, in Draft, sitting in the service account's court where nobody is
 * looking — and the only way back to them was to remember they existed.
 *
 * So the app asks Procore instead of relying on the superintendent's memory.
 * This is deliberately narrow: only Draft items, and only ones this integration
 * created. A draft somebody is still writing in Procore is none of our business.
 */
export async function draftsHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!procoreConfigured()) {
    return errorResponse(503, 'Procore is not configured on this deployment.');
  }

  const projectId = Number(request.query.get('project_id') || 0);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return errorResponse(400, 'Pass ?project_id=<procore project id>.');
  }

  try {
    const [rows, ourUserId] = await Promise.all([listPunchItems(projectId), serviceAccountId()]);

    // Without an identity every item looks like someone else's, which is the
    // safe way to be wrong — say so rather than reporting an empty list, which
    // would read as "nothing is stuck".
    if (!ourUserId) {
      return json({ projectId, unknown: true, drafts: [] });
    }

    const drafts = rows
      .filter((row) => isUnsentImport(row, ourUserId))
      .map((row) => ({
        id: row.id as number,
        number: (row.position ?? null) as number | null,
        name: (row.name ?? '') as string,
        createdAt: (row.created_at ?? null) as string | null,
      }))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

    return json({ projectId, unknown: false, drafts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(`drafts project=${projectId}: ${message}`);
    return errorResponse(502, `Could not read this project's punch list: ${message}`);
  }
}

app.http('drafts', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'drafts',
  handler: guarded('drafts', draftsHandler),
});
