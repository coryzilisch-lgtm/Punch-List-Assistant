import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { errorResponse, guarded, json } from '../lib/http';
import { procoreConfigured, procoreRequest, ProcoreError } from '../lib/procore';
import { quotaReport } from '../lib/quota';

/**
 * GET /api/quota — how much of Procore's rate limit is left, and how many items
 * that is room for.
 *
 * One request (`/me`, the cheapest call there is), read for its headers. The
 * dashboard asks before a push so it can push what fits and say when to come
 * back for the rest, instead of finding out from 78 red rows. A 429 here is an
 * answer too: the quota is spent, and the report says until when.
 */
export async function quotaHandler(_request: HttpRequest): Promise<HttpResponseInit> {
  if (!procoreConfigured()) return errorResponse(503, 'Procore is not configured on this deployment.');
  try {
    await procoreRequest('GET', '/rest/v1.0/me');
  } catch (err) {
    if (!(err instanceof ProcoreError) || err.status !== 429) throw err;
  }
  return json(quotaReport(Date.now()));
}

app.http('quota', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'quota',
  handler: guarded('quota', quotaHandler),
});
