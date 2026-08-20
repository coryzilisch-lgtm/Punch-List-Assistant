import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, json } from '../lib/http';
import {
  companyId,
  getProjectPunchConfig,
  listPunchItems,
  ProcoreError,
  procoreConfigured,
  procoreRequest,
} from '../lib/procore';
import { extractionConfigured, extractionModel } from '../lib/extract';

/**
 * GET /api/probe?project_id=123 — what can this deployment actually do?
 *
 * Written because the two things most likely to be wrong on a fresh deployment
 * are invisible from the UI: whether the Procore service account can WRITE to
 * the Punch List tool on a given project, and whether the tenant requires fields
 * we are not sending. Both surface as a confusing failure on the very last step
 * of a super's workflow, after they have already done the review work.
 *
 * This endpoint answers those questions up front, in plain language, without
 * creating anything. It is read-only by design — see the note on the write check.
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function probeHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const checks: Check[] = [];
  const projectId = Number(request.query.get('project_id') || 0);

  checks.push({
    name: 'Document reading (Anthropic)',
    ok: extractionConfigured(),
    detail: extractionConfigured()
      ? `Configured, using ${extractionModel()}.`
      : 'ANTHROPIC_API_KEY is missing from the app settings. Uploads will not be readable.',
  });

  if (!procoreConfigured()) {
    checks.push({
      name: 'Procore credentials',
      ok: false,
      detail:
        'PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET and/or PROCORE_COMPANY_ID are missing from the app settings.',
    });
    return json({ checks, ready: false });
  }

  // 1. Can we authenticate at all?
  try {
    await procoreRequest('GET', '/rest/v1.0/me');
    checks.push({ name: 'Procore credentials', ok: true, detail: `Authenticated against company ${companyId()}.` });
  } catch (err) {
    checks.push({
      name: 'Procore credentials',
      ok: false,
      detail: describe(err, 'Could not authenticate with Procore.'),
    });
    return json({ checks, ready: false });
  }

  if (!projectId) {
    checks.push({
      name: 'Project checks',
      ok: true,
      detail: 'Pass ?project_id=<id> to also check punch list access on a specific project.',
    });
    return json({ checks, ready: checks.every((c) => c.ok) });
  }

  // 2. Can we READ the punch list tool on this project? A 403 here means the
  //    service account lacks the Punch List tool permission, which is the exact
  //    thing that would break the push at the end.
  try {
    const items = await listPunchItems(projectId);
    checks.push({
      name: 'Punch list read access',
      ok: true,
      detail: `Readable — project currently has ${items.length} punch item(s).`,
    });
  } catch (err) {
    checks.push({
      name: 'Punch list read access',
      ok: false,
      detail: describe(
        err,
        'Could not read the punch list. The service account likely needs the Punch List tool enabled on this project.',
      ),
    });
  }

  // 3. Which dropdowns will actually have values?
  try {
    const config = await getProjectPunchConfig(projectId);
    const parts = [
      `${config.punchItemTypes.length} type(s)`,
      `${config.locations.length} location(s)`,
      `${config.trades.length} trade(s)`,
      `${config.users.length} project user(s)`,
      `${config.vendors.length} vendor(s)`,
    ].join(', ');
    checks.push({
      name: 'Punch list configuration',
      ok: true,
      detail: config.warnings.length ? `${parts}. Warnings: ${config.warnings.join('; ')}` : parts,
    });
  } catch (err) {
    checks.push({
      name: 'Punch list configuration',
      ok: false,
      detail: describe(err, 'Could not read the project punch list configuration.'),
    });
  }

  // NOTE: there is deliberately no write check here. Procore has no validate-only
  // mode for punch items, so the only way to test writing is to create a real one
  // — which would litter a live project with test rows that a super then has to
  // delete. Use the review screen's "Preview payloads" (dry run) to inspect
  // exactly what would be sent, then push a single item as the real test.
  checks.push({
    name: 'Punch list write access',
    ok: true,
    detail:
      'Not tested. Procore offers no validate-only mode, so testing a write means creating a real punch item. Push one item first and read the result before sending the rest.',
  });

  return json({ checks, ready: checks.every((c) => c.ok), projectId });
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof ProcoreError) {
    const fields = err.fieldErrors();
    return `${fallback} (HTTP ${err.status}${fields.length ? `: ${fields.join('; ')}` : ''})`;
  }
  return `${fallback} (${err instanceof Error ? err.message : String(err)})`;
}

app.http('probe', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'probe',
  handler: probeHandler,
});
