import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, guarded, json } from '../lib/http';
import { listPunchItems, ProcoreError, procoreConfigured, procoreRequest } from '../lib/procore';

/**
 * GET /api/inspect?project_id=123[&punch_item_id=274] — read Procore's own shapes.
 *
 * Why this exists, bluntly: this integration has now written to Procore three
 * times, been answered 200 three times, and stored nothing three times —
 * attachments twice and assignees once. Every one of those attempts was built
 * from a guess at the field names, because `developers.procore.com` is
 * unreachable from this environment (the egress proxy answers CONNECT with 403),
 * so the write contract has been inferred from search-result snippets.
 *
 * Guessing a fourth time is the wrong move. A tenant that already contains
 * hundreds of punch items created through Procore's own UI is a better
 * specification than any documentation: those rows carry the real field names,
 * the real nesting, and the real values. This endpoint reads them back and
 * reports the shape, so the write payload can be built from evidence.
 *
 * Strictly read-only. It creates, updates and deletes nothing.
 */

/** Values worth printing in full; anything longer is truncated for the report. */
const MAX_SCALAR_LEN = 120;
/** A field with more distinct values than this is data, not an enum. */
const MAX_DISTINCT = 12;
/** Full raw JSON is heavy — return a few illustrative rows, not the project. */
const MAX_RAW = 3;

type Row = Record<string, unknown>;

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function short(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_SCALAR_LEN) return `${v.slice(0, MAX_SCALAR_LEN)}…`;
  return v;
}

/**
 * Distribution of every scalar field that behaves like an enum.
 *
 * This is the part that answers "which field says Draft?" without knowing its
 * name in advance. A workflow flag shows up here as a handful of repeated
 * values across hundreds of rows; a title or a timestamp does not, and drops out
 * on the distinct-count test.
 */
function enumFields(rows: Row[]): Record<string, Record<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!isScalar(value)) continue;
      const bucket = counts.get(key) ?? new Map<string, number>();
      const label = String(value);
      bucket.set(label, (bucket.get(label) ?? 0) + 1);
      counts.set(key, bucket);
    }
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [key, bucket] of counts) {
    if (bucket.size > MAX_DISTINCT) continue;
    out[key] = Object.fromEntries([...bucket].sort((a, b) => b[1] - a[1]));
  }
  return out;
}

/**
 * Which fields ever hold a non-empty array, and what one element looks like.
 *
 * Attachments and assignees are both array-shaped, and both are currently
 * arriving empty on the items this app creates. Finding a UI-created row where
 * they are populated is what pins down the key name and the element shape.
 */
function collectionFields(rows: Row[]): Record<string, { rowsWithValues: number; example: unknown }> {
  const out: Record<string, { rowsWithValues: number; example: unknown }> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const seen = out[key] ?? { rowsWithValues: 0, example: value[0] };
      seen.rowsWithValues += 1;
      out[key] = seen;
    }
  }
  return out;
}

/** Object-valued fields (`punch_item_manager`, `ball_in_court`, …) and their keys. */
function objectFields(rows: Row[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!out[key]) out[key] = Object.keys(value as Row);
    }
  }
  return out;
}

/** Pick the handful of rows most likely to teach us something. */
function interesting(rows: Row[]): Array<{ why: string; id: unknown }> {
  const picks: Array<{ why: string; id: unknown }> = [];
  const take = (why: string, match: (r: Row) => boolean) => {
    if (picks.length >= MAX_RAW) return;
    const hit = rows.find((r) => match(r) && !picks.some((p) => p.id === r.id));
    if (hit) picks.push({ why, id: hit.id });
  };

  const nonEmpty = (r: Row, keys: string[]) =>
    keys.some((k) => Array.isArray(r[k]) && (r[k] as unknown[]).length > 0);

  take('has attachments', (r) => nonEmpty(r, ['attachments', 'images', 'attachment', 'documents']));
  take('has assignees', (r) => nonEmpty(r, ['assignments', 'assignees', 'punch_item_assignments']));
  take('has a ball-in-court', (r) => Boolean(r.ball_in_court) || nonEmpty(r, ['ball_in_courts']));
  return picks;
}

export async function inspectHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!procoreConfigured()) {
    return errorResponse(503, 'Procore is not configured on this deployment.');
  }

  const projectId = Number(request.query.get('project_id') || 0);
  if (!projectId) {
    return errorResponse(400, 'Pass ?project_id=<procore project id>.');
  }

  const punchItemId = Number(request.query.get('punch_item_id') || 0);

  // Single-item mode: dump one item verbatim. Used to read back an item this app
  // created, and to compare it field-by-field against one Procore's UI created.
  if (punchItemId) {
    try {
      const item = await procoreRequest<Row>('GET', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
      });
      return json({ projectId, punchItemId, keys: Object.keys(item).sort(), item });
    } catch (err) {
      context.error(`inspect item ${punchItemId} failed: ${String(err)}`);
      return errorResponse(
        err instanceof ProcoreError && err.status === 404 ? 404 : 502,
        `Could not read punch item ${punchItemId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Survey mode.
  let rows: Row[];
  try {
    rows = await listPunchItems(projectId);
  } catch (err) {
    context.error(`inspect list failed: ${String(err)}`);
    return errorResponse(502, `Could not list punch items: ${err instanceof Error ? err.message : String(err)}`);
  }

  const picks = interesting(rows);
  const raw: Array<{ why: string; id: unknown; item: unknown; error?: string }> = [];
  for (const pick of picks) {
    try {
      // The list view is slimmer than the show view — attachments in particular
      // are often summarized or omitted — so fetch each candidate individually.
      const item = await procoreRequest<Row>('GET', `/rest/v1.1/punch_items/${pick.id}`, {
        query: { project_id: projectId },
      });
      raw.push({ ...pick, item });
    } catch (err) {
      raw.push({ ...pick, item: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json({
    projectId,
    itemCount: rows.length,
    listKeys: [...new Set(rows.flatMap((r) => Object.keys(r)))].sort(),
    enums: enumFields(rows),
    collections: collectionFields(rows),
    objects: objectFields(rows),
    newest: rows.slice(-3).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => isScalar(v)).map(([k, v]) => [k, short(v)]))),
    raw,
  });
}

app.http('inspect', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'inspect',
  handler: guarded('inspect', inspectHandler),
});
