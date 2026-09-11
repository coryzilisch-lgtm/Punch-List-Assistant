/**
 * Procore API client.
 *
 * Auth is OAuth 2.0 client-credentials (server-to-server, no user interaction),
 * the same grant the Safety Dashboard's Fabric notebooks use. Tokens last ~2h;
 * `getToken()` re-mints ~5 minutes before expiry and every request force-refreshes
 * once on a 401 before giving up.
 *
 * ── On the punch-item WRITE contract ────────────────────────────────────────
 * Procore's punch list is one of the most tenant-configurable tools in the
 * product: which fields are required is decided per-company in the Punch List
 * tool's configuration, not by the API's own schema. `punch_item_manager_id` and
 * `final_approver_id` are required in most tenants, and a tenant can additionally
 * mark type / location / trade / due date / priority required.
 *
 * So this client does NOT hardcode a required-field set. It sends whatever the
 * caller mapped, and `createPunchItem` returns Procore's raw error body verbatim
 * on a 4xx so the UI can show the field names Procore itself named. Pair that
 * with `/api/procore/probe`, which reports what the service account can actually
 * read and write on a given project. The first live push against a real project
 * is what pins the contract down — treat any list of "required fields" written
 * from memory (including in this comment) as a hypothesis until then.
 */

const LOGIN_BASE = process.env.PROCORE_LOGIN_BASE_URL || 'https://login.procore.com';
const API_BASE = process.env.PROCORE_API_BASE_URL || 'https://api.procore.com';

const TOKEN_SKEW_MS = 5 * 60 * 1000; // re-mint 5 min early
const MAX_RETRIES = 4;

/**
 * The longest a rate-limit wait can be before it is pointless to wait at all.
 * SWA managed Functions are killed at 45 seconds, so anything longer turns a
 * diagnosable 429 into an undiagnosable platform kill.
 */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

export class ProcoreError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`Procore ${status} on ${method} ${path}: ${summarize(body)}`);
    this.name = 'ProcoreError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }

  /**
   * Field-level validation messages, when Procore returned any. Procore is
   * inconsistent here — sometimes `{errors: {field: [msg]}}`, sometimes
   * `{errors: [msg]}`, sometimes `{message: msg}` — so normalize all three.
   */
  fieldErrors(): string[] {
    const b = this.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return [];
    const errs = b.errors;
    if (Array.isArray(errs)) return errs.map(String);
    if (errs && typeof errs === 'object') {
      return Object.entries(errs as Record<string, unknown>).flatMap(([field, msgs]) =>
        (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${field} ${String(m)}`),
      );
    }
    if (typeof b.message === 'string') return [b.message];
    return [];
  }
}

function summarize(body: unknown): string {
  if (body == null) return '(empty body)';
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

// ── Token management ────────────────────────────────────────────────────────

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

export function procoreConfigured(): boolean {
  return Boolean(
    process.env.PROCORE_CLIENT_ID &&
      process.env.PROCORE_CLIENT_SECRET &&
      process.env.PROCORE_COMPANY_ID,
  );
}

export function companyId(): string {
  const id = process.env.PROCORE_COMPANY_ID;
  if (!id) throw new Error('PROCORE_COMPANY_ID is not set');
  return id;
}

export async function getToken(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) {
    return cached.value;
  }
  // Collapse concurrent refreshes — a page-by-page extraction run can fire
  // several requests at once and we do not want N token mints.
  if (!force && inFlight) return inFlight;

  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PROCORE_CLIENT_ID / PROCORE_CLIENT_SECRET are not set');
  }

  const mint = (async () => {
    const res = await fetch(`${LOGIN_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const body = await readBody(res);
    if (!res.ok) throw new ProcoreError('POST', '/oauth/token', res.status, body);

    const token = (body as { access_token?: string }).access_token;
    const expiresIn = (body as { expires_in?: number }).expires_in ?? 7200;
    if (!token) throw new Error('Procore token response had no access_token');

    cached = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  })().finally(() => {
    inFlight = null;
  });

  inFlight = mint;
  return mint;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Request helpers ─────────────────────────────────────────────────────────

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Multipart body. When set, `body` is ignored and Content-Type is left to fetch. */
  form?: FormData;
  /** Procore-Company-Id header. Defaults to PROCORE_COMPANY_ID. */
  company?: string;
  /**
   * Extra headers. Exists for Procore's act-on-behalf-of header, which is what
   * decides whether a punch item is created BY the superintendent or by the
   * integration's service account.
   */
  headers?: Record<string, string>;
}

export async function procoreRequest<T = unknown>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let forceRefresh = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const token = await getToken(forceRefresh);
    forceRefresh = false;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      // Missing this header is a 403, not a 401 — the single most common
      // Procore integration mistake.
      'Procore-Company-Id': opts.company || companyId(),
      Accept: 'application/json',
      ...(opts.headers || {}),
    };

    let payload: BodyInit | undefined;
    if (opts.form) {
      payload = opts.form; // fetch sets the multipart boundary itself
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), { method, headers, body: payload });
    } catch (err) {
      // Network-level failure. Retry with backoff; a socket reset mid-run
      // should not lose a whole import.
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return (await readBody(res)) as T;

    const body = await readBody(res);

    if (res.status === 401 && attempt < MAX_RETRIES) {
      // Token died mid-run (long imports outlive a 2h token). Re-mint once
      // and retry rather than surfacing this as a permissions problem.
      forceRefresh = true;
      continue;
    }

    if (res.status === 429) {
      const reset = Number(res.headers.get('X-Rate-Limit-Reset') || 0);
      const waitMs = reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : backoffMs(attempt);

      // Waiting out a rate limit inside a Function that is killed at 45 seconds
      // does not produce a rate-limit error — it produces Azure's opaque
      // "Backend call failure", which looks like the app is broken. This used
      // to sleep up to 60s and could never have succeeded. Wait only if the
      // window is short; otherwise say plainly what happened.
      if (attempt < MAX_RETRIES && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs);
        continue;
      }

      const seconds = Math.ceil(waitMs / 1000);
      throw new ProcoreError(method, url.pathname, 429, {
        message:
          `Procore rate limit reached; it resets in about ${seconds}s. ` +
          'The API service account is shared with the Safety Dashboard ingest, so a large sync ' +
          'running at the same time can exhaust the company quota.',
      });
    }

    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new ProcoreError(method, url.pathname, res.status, body);
  }

  throw new Error(`Procore request exhausted retries: ${method} ${path}`);
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 16_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Paginate a v1.x list endpoint (bare-array response).
 *
 * `budgetMs` exists because SWA managed Functions are killed at 45 seconds with
 * no error the app can catch — the caller just sees Azure's "Backend call
 * failure", which says nothing about what went wrong. Serial page fetches plus
 * Procore's rate-limit backoff can reach that ceiling easily, so pagination
 * stops early and reports truncation instead of being killed mid-loop.
 */
export async function procorePaginate<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  perPage = 100,
  budgetMs = 0,
): Promise<T[]> {
  return (await paginateWithBudget<T>(path, opts, perPage, budgetMs)).rows;
}

export async function paginateWithBudget<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  perPage = 100,
  budgetMs = 0,
): Promise<{ rows: T[]; truncated: boolean }> {
  const out: T[] = [];
  const started = Date.now();

  for (let page = 1; page <= 100; page++) {
    const body = await procoreRequest<unknown>('GET', path, {
      ...opts,
      query: { ...opts.query, page, per_page: perPage },
    });
    const rows: T[] = Array.isArray(body)
      ? (body as T[])
      : body && typeof body === 'object' && Array.isArray((body as { data?: T[] }).data)
        ? ((body as { data: T[] }).data)
        : [];
    out.push(...rows);
    if (rows.length < perPage) return { rows: out, truncated: false };
    if (budgetMs && Date.now() - started > budgetMs) {
      return { rows: out, truncated: true };
    }
  }
  return { rows: out, truncated: true };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface ProcoreProject {
  id: number;
  name: string;
  project_number?: string | null;
  active?: boolean;
  /** Procore returns stage either as a string or a {name} object depending on endpoint. */
  project_stage?: { name?: string } | string | null;
}

/**
 * Projects the picker can import into.
 *
 * Filtered to ACTIVE and fetched 300 at a time. The first version asked for
 * every project the company has ever had, 100 per page, as serial requests —
 * which on a real tenant runs past the 45-second Function ceiling and gets the
 * whole invocation killed, surfacing as Azure's opaque "Backend call failure".
 *
 * Active is also the right answer, not just the fast one: a punch list is
 * imported into a job that is being built. A closed-out project in the list is
 * a wrong choice waiting to be made. `PUNCH_PROJECT_STATUS=all` widens it if a
 * closed job ever genuinely needs an import.
 */
export async function listProjects(): Promise<{ projects: ProcoreProject[]; truncated: boolean }> {
  const status = process.env.PUNCH_PROJECT_STATUS || 'Active';
  const { rows, truncated } = await paginateWithBudget<ProcoreProject>(
    '/rest/v1.1/projects',
    { query: { company_id: companyId(), 'filters[by_status]': status } },
    300,
    // Well inside the 45s ceiling, leaving room for the token mint and the
    // response itself.
    25_000,
  );
  return { projects: rows, truncated };
}

/**
 * Look up one project by its Procore id.
 *
 * Backs the "type the id" escape hatch in the picker. It goes to Procore rather
 * than the Fabric mirror on purpose: the whole reason someone types an id is
 * that the project is missing from the mirrored list — usually because it was
 * created since last night's sync. Reading the mirror again would just fail the
 * same way.
 *
 * Returns null for an id that does not exist or is not visible to the service
 * account, so the caller can say which of those it was.
 */
export async function getProject(projectId: number): Promise<ProcoreProject | null> {
  // v1.0 is the documented detail endpoint; v1.1 answers on some tenants.
  for (const path of [`/rest/v1.0/projects/${projectId}`, `/rest/v1.1/projects/${projectId}`]) {
    try {
      const row = await procoreRequest<ProcoreProject>('GET', path, {
        query: { company_id: companyId() },
      });
      if (row && typeof row.id === 'number') return row;
    } catch (err) {
      // A 404 means "not this endpoint" or "no such project" — try the other
      // before concluding anything. Anything else is a real failure.
      if (err instanceof ProcoreError && (err.status === 404 || err.status === 400)) continue;
      throw err;
    }
  }
  return null;
}

export interface NamedRef {
  id: number;
  name: string;
}

/**
 * Everything the review UI needs to offer real Procore values in its dropdowns
 * instead of free text. Each lookup is independent and individually optional —
 * a tenant that does not use Trades, or a project with no Locations defined,
 * should still be able to import. So each one degrades to an empty list rather
 * than failing the whole request.
 */
export interface ProjectPunchConfig {
  projectId: number;
  punchItemTypes: NamedRef[];
  locations: NamedRef[];
  trades: NamedRef[];
  vendors: NamedRef[];
  users: Array<NamedRef & { email?: string | null; company?: string | null }>;
  /** Lookups that failed, so the UI can say which dropdown is empty and why. */
  warnings: string[];
}

export async function getProjectPunchConfig(projectId: number): Promise<ProjectPunchConfig> {
  const warnings: string[] = [];

  const soft = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof ProcoreError ? `${err.status}` : String(err);
      warnings.push(`${label} unavailable (${msg})`);
      return [];
    }
  };

  const [punchItemTypes, locations, trades, vendors, users] = await Promise.all([
    soft('Punch item types', () =>
      procorePaginate<NamedRef>('/rest/v1.0/punch_item_types', { query: { project_id: projectId } }),
    ),
    soft('Locations', () =>
      procorePaginate<NamedRef>('/rest/v1.0/locations', { query: { project_id: projectId } }),
    ),
    soft('Trades', () =>
      procorePaginate<NamedRef>('/rest/v1.0/trades', { query: { project_id: projectId } }),
    ),
    soft('Vendors', () =>
      procorePaginate<NamedRef>(`/rest/v1.0/companies/${companyId()}/vendors`, {}),
    ),
    soft('Project users', () =>
      procorePaginate<{ id: number; name: string; email_address?: string; vendor?: { name?: string } }>(
        `/rest/v1.0/projects/${projectId}/users`,
        {},
      ),
    ),
  ]);

  return {
    projectId,
    punchItemTypes,
    locations,
    trades,
    vendors,
    users: (users as Array<{ id: number; name: string; email_address?: string; vendor?: { name?: string } }>).map(
      (u) => ({ id: u.id, name: u.name, email: u.email_address ?? null, company: u.vendor?.name ?? null }),
    ),
    warnings,
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface PunchItemInput {
  name: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | null;
  dueDate?: string | null; // YYYY-MM-DD
  punchItemTypeId?: number | null;
  locationId?: number | null;
  tradeId?: number | null;
  /** Punch Item Manager — required in most tenant configurations. */
  punchItemManagerId?: number | null;
  /** Final Approver — required in most tenant configurations. */
  finalApproverId?: number | null;
  /** Assignee user ids (Ball in Court). */
  assigneeIds?: number[];
  /** Assignee vendor/company id, when assigning to a sub rather than a person. */
  vendorId?: number | null;
  /** Free-text reference (we stamp the source doc + original issue number here). */
  reference?: string | null;
}

/** Photo to attach, already decoded from the browser's crop. */
export interface PunchPhoto {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Shape the `punch_item[...]` payload. Split out from `createPunchItem` so the
 * dry-run path can show operators the exact body without sending it.
 */
export function buildPunchItemPayload(input: PunchItemInput): Record<string, unknown> {
  const item: Record<string, unknown> = { name: input.name };

  if (input.description) item.description = input.description;
  if (input.priority) item.priority = input.priority;
  if (input.dueDate) item.due_date = input.dueDate;
  if (input.punchItemTypeId) item.punch_item_type_id = input.punchItemTypeId;
  if (input.locationId) item.location_id = input.locationId;
  if (input.tradeId) item.trade_id = input.tradeId;
  if (input.punchItemManagerId) item.punch_item_manager_id = input.punchItemManagerId;
  if (input.finalApproverId) item.final_approver_id = input.finalApproverId;
  if (input.reference) item.reference = input.reference;

  // Assignments carry the ball-in-court, and the key is `login_information_id`.
  //
  // Not `assignee_id`, which is what this sent first and what Procore accepted
  // and silently dropped. The real name came off an assignment Procore's own UI
  // created: the row nests the person under `login_information` and the list
  // view spells the scalar out as `login_information_id`. A Rails controller
  // filters an unpermitted key without complaining, which is exactly the shape
  // of the failure that was seen — 200, and no assignee.
  const assignees = input.assigneeIds || [];
  if (assignees.length || input.vendorId) {
    item.assignments = assignees.length
      ? assignees.map((id) => ({
          login_information_id: id,
          ...(input.vendorId ? { vendor_id: input.vendorId } : {}),
        }))
      : [{ vendor_id: input.vendorId }];
  }

  return item;
}

export interface CreatedPunchItem {
  id: number;
  number?: number | string | null;
  name?: string;
}

/**
 * What Procore actually stored, read back after the write.
 *
 * This exists because both of this integration's first production bugs were
 * SILENT: the attachment PATCH returned 200 and attached nothing, and the
 * assignment was accepted and ignored, leaving ball-in-court on the API service
 * account. Both looked like success to the app and like a mistake to the
 * superintendent. Reading the item back turns "we sent it" into "Procore has
 * it", which is the only claim worth making.
 */
export interface ObservedPunchItem {
  /** Procore's `status` field — which is open/closed, NOT the workflow state. */
  status: string | null;
  /** The workflow state Procore's UI shows as Draft / Initiated, when findable. */
  workflowLabel: string | null;
  /** true / false when the workflow state was readable, null when it was not. */
  isDraft: boolean | null;
  attachmentCount: number;
  /**
   * Procore's own `has_attachments` boolean. The show payload carries both an
   * `attachments` array and this flag; the flag is the one to trust, because a
   * list view can summarize the array away while the flag stays accurate.
   */
  hasAttachments: boolean | null;
  ballInCourt: string[];
  assignees: string[];
  punchItemManager: string | null;
}

/**
 * Work out whether Procore considers this item a Draft.
 *
 * This is separated out and deliberately cautious because the first version of
 * the send step got it wrong in a way that failed silently. It gated on
 * `status === 'draft'`, and Procore's `status` field turned out to be the
 * open/closed status: an item the UI plainly labels **Draft** reads back as
 * `status: "open"`. The gate was therefore never true, the send never ran, and
 * the app reported no error — the super ticked "send to the punch item manager",
 * nothing happened, and nothing said so.
 *
 * The workflow field's real name is not known from here (Procore's API reference
 * is unreachable behind this environment's egress proxy), so this checks the
 * plausible names and, crucially, returns **null** rather than false when none of
 * them resolve. Unknown must not be read as "already sent" — that is precisely
 * the failure above. `/api/inspect` exists to replace this guesswork with the
 * field name the tenant actually uses.
 */
const DRAFT_BOOLEAN_KEYS = ['draft', 'is_draft'];
// `workflow_status` is confirmed against the tenant: item #274 read back as
// `status: "Closed", workflow_status: "closed"`, so the two fields track
// different things and only the second one carries Draft / Initiated.
const DRAFT_LABEL_KEYS = ['workflow_status', 'punch_item_status', 'item_status', 'stage'];
const NON_DRAFT_LABELS = new Set([
  'initiated',
  'ready_for_review',
  'work_required',
  'work_not_accepted',
  'in_dispute',
  'ready_to_close',
  'approved',
  'closed',
]);

function draftState(row: Record<string, unknown>): { isDraft: boolean | null; label: string | null } {
  for (const key of DRAFT_BOOLEAN_KEYS) {
    if (typeof row[key] === 'boolean') {
      return { isDraft: row[key] as boolean, label: row[key] ? 'draft' : null };
    }
  }
  for (const key of DRAFT_LABEL_KEYS) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const label = value.toLowerCase().replace(/\s+/g, '_');
    if (label === 'draft') return { isDraft: true, label: value };
    if (NON_DRAFT_LABELS.has(label)) return { isDraft: false, label: value };
  }
  // `status` is only ever evidence of a draft here, never evidence against one:
  // it reads "open" on an item the UI calls Draft.
  if (typeof row.status === 'string' && row.status.toLowerCase() === 'draft') {
    return { isDraft: true, label: 'draft' };
  }
  return { isDraft: null, label: null };
}

function nameOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  const o = v as { name?: string; login?: string };
  return o.name || o.login || null;
}

function namesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((entry) => {
      const e = entry as Record<string, unknown>;
      // An assignment from the show endpoint nests the person under
      // `login_information` and carries NO top-level name — only the slimmer
      // list view does. Missing that would have reported a correctly assigned
      // item as unassigned, and then "fixed" it by retrying writes that had
      // already worked.
      return nameOf(e?.login_information ?? e?.assignee ?? e?.user ?? e?.vendor ?? entry);
    })
    .filter((n): n is string => Boolean(n));
}

/** Read one punch item back and summarize the fields we care about. */
export async function observePunchItem(
  projectId: number,
  punchItemId: number,
): Promise<ObservedPunchItem | null> {
  try {
    const row = await procoreRequest<Record<string, unknown>>(
      'GET',
      `/rest/v1.1/punch_items/${punchItemId}`,
      { query: { project_id: projectId } },
    );
    const attachments = row.attachments ?? row.images ?? [];
    const draft = draftState(row);
    return {
      status: typeof row.status === 'string' ? row.status : null,
      workflowLabel: draft.label,
      isDraft: draft.isDraft,
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      hasAttachments: typeof row.has_attachments === 'boolean' ? row.has_attachments : null,
      ballInCourt: namesOf(row.ball_in_court ?? row.ball_in_courts),
      assignees: namesOf(row.assignments ?? row.assignees),
      punchItemManager: nameOf(row.punch_item_manager),
    };
  } catch {
    // Verification is a nicety; never fail a successful create over it.
    return null;
  }
}

/**
 * Flatten the punch item payload into Rails-style multipart keys.
 *
 * `punch_item[name]`, `punch_item[assignments][][assignee_id]`, and so on —
 * Procore is a Rails app and parses bracket notation back into the same nested
 * hash the JSON body produces.
 */
function appendNested(form: FormData, prefix: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendNested(form, `${prefix}[]`, entry);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendNested(form, `${prefix}[${k}]`, v);
    }
    return;
  }
  form.append(prefix, String(value));
}

/**
 * The file part is `punch_item[attachments][]`.
 *
 * `images[]` was the guess behind two of the three silent failures, and an item
 * Procore's UI put a photo on settles it: that item reads back with the photo in
 * **`attachments`** (and mirrored into `web_images`), while `images` is an empty
 * array. `images` is a field this product no longer fills. Sending a file under
 * a name the controller does not permit is dropped without comment, which is
 * why every attempt returned 200 and stored nothing.
 *
 * Photos go on the create, with a plain-JSON create as the fallback so a photo
 * Procore rejects costs the photo and not the whole row.
 */
async function createWithPhotos(
  projectId: number,
  input: PunchItemInput,
  photos: PunchPhoto[],
): Promise<CreatedPunchItem> {
  const form = new FormData();
  form.append('project_id', String(projectId));
  appendNested(form, 'punch_item', buildPunchItemPayload(input));
  for (const photo of photos) {
    form.append(
      'punch_item[attachments][]',
      new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
      photo.filename,
    );
  }

  return procoreRequest<CreatedPunchItem>('POST', '/rest/v1.1/punch_items', {
    query: { project_id: projectId },
    form,
  });
}

/**
 * Move a Draft item to Initiated.
 *
 * Procore's rule: an item is Draft when its creator is not its Punch Item
 * Manager, and Initiated once it has been sent to that manager. Everything this
 * app creates is therefore Draft — the API service account creates it, a real
 * person is the manager — and a Draft item sits in its CREATOR's court. That is
 * why every imported item showed ball-in-court on the service account: not a bug
 * in the payload, the workflow simply had not started.
 *
 * This is opt-in per push, because sending is what notifies the manager and
 * assignees. Sending sixty items silently would put sixty emails in front of
 * people who never agreed to receive them.
 */
interface WriteStrategy<A extends unknown[]> {
  label: string;
  run: (projectId: number, punchItemId: number, ...args: A) => Promise<void>;
}

/**
 * A signature of everything a workflow change is expected to move.
 *
 * Verification cannot rely on one field, because the field that carries the
 * workflow state has not been identified yet. Comparing a snapshot before and
 * after means "something Procore shows the super actually changed" counts as
 * evidence even when the specific field name is still unknown — and, just as
 * importantly, "nothing changed" is reported as a failure instead of being
 * announced as a success, which is how the first three write bugs got shipped.
 */
function workflowSignature(o: ObservedPunchItem | null): string {
  if (!o) return '';
  return JSON.stringify([o.status, o.workflowLabel, o.isDraft, o.ballInCourt, o.assignees]);
}

const SEND_STRATEGIES: Array<WriteStrategy<[]>> = [
  {
    label: 'PATCH draft=false',
    run: (projectId, id) =>
      procoreRequest('PATCH', `/rest/v1.1/punch_items/${id}`, {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: { draft: false } },
      }).then(() => undefined),
  },
  {
    label: 'PATCH workflow_status=initiated',
    run: (projectId, id) =>
      procoreRequest('PATCH', `/rest/v1.1/punch_items/${id}`, {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: { workflow_status: 'initiated' } },
      }).then(() => undefined),
  },
  {
    label: 'POST send',
    run: (projectId, id) =>
      procoreRequest('POST', `/rest/v1.1/punch_items/${id}/send`, {
        query: { project_id: projectId },
        body: { project_id: projectId },
      }).then(() => undefined),
  },
];

/**
 * Remember what worked, and what could not be made to work.
 *
 * A push is up to ten items, and a punch list is sixty. Re-running a chain of
 * guesses per item would multiply both the wall clock (the Function is killed at
 * 45 seconds) and the Procore rate-limit budget by the length of the chain, for
 * an answer that cannot change between two items a second apart. So the first
 * item in a process pays for the discovery and every later one takes the short
 * path — including the unhappy short path, where the whole chain has already
 * been shown not to work and re-proving it just burns the quota.
 */
const memo: {
  send: string | null;
  sendFailure: string[] | null;
  assign: string | null;
  assignFailure: string[] | null;
  attach: string | null;
  attachFailure: string[] | null;
} = {
  send: null,
  sendFailure: null,
  assign: null,
  assignFailure: null,
  attach: null,
  attachFailure: null,
};

function ordered<A extends unknown[]>(list: Array<WriteStrategy<A>>, known: string | null) {
  if (!known) return list;
  const hit = list.find((s) => s.label === known);
  return hit ? [hit, ...list.filter((s) => s !== hit)] : list;
}

function describeError(err: unknown): string {
  return err instanceof ProcoreError
    ? `${err.status} ${err.fieldErrors().join('; ') || summarize(err.body)}`
    : String(err);
}

/**
 * Attach photos to an item that already exists.
 *
 * Only runs when the create did not carry them, so in the happy path it costs
 * nothing. It exists because losing the photos is recoverable in the field and
 * losing the row is not: whatever happens here, the superintendent still has the
 * item in Procore and a report of what is missing from it.
 */
const ATTACH_STRATEGIES: Array<WriteStrategy<[PunchPhoto[]]>> = [
  {
    label: 'PATCH punch_item[attachments][]',
    run: async (projectId, punchItemId, photos) => {
      const form = new FormData();
      form.append('project_id', String(projectId));
      for (const photo of photos) {
        form.append(
          'punch_item[attachments][]',
          new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
          photo.filename,
        );
      }
      await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
        form,
      });
    },
  },
  {
    label: 'PATCH attachments[]',
    run: async (projectId, punchItemId, photos) => {
      const form = new FormData();
      form.append('project_id', String(projectId));
      for (const photo of photos) {
        form.append(
          'attachments[]',
          new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
          photo.filename,
        );
      }
      await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
        form,
      });
    },
  },
];

/** How many photos Procore says it is holding, trusting its own flag first. */
function storedPhotos(o: ObservedPunchItem | null): number {
  if (!o) return 0;
  if (o.hasAttachments === false) return 0;
  return o.attachmentCount;
}

async function ensurePhotos(
  projectId: number,
  punchItemId: number,
  photos: PunchPhoto[],
  observed: ObservedPunchItem | null,
): Promise<{ errors: string[]; observed: ObservedPunchItem | null }> {
  if (!photos.length || storedPhotos(observed) > 0) return { errors: [], observed };
  if (memo.attachFailure) return { errors: memo.attachFailure, observed };

  const errors: string[] = [];
  for (const strategy of ordered(ATTACH_STRATEGIES, memo.attach)) {
    try {
      await strategy.run(projectId, punchItemId, photos);
      const after = await observePunchItem(projectId, punchItemId);
      if (storedPhotos(after) > 0) {
        memo.attach = strategy.label;
        return { errors, observed: after };
      }
      errors.push(`${strategy.label}: accepted but stored no attachment`);
    } catch (err) {
      errors.push(`${strategy.label}: ${describeError(err)}`);
    }
  }

  memo.attachFailure = errors;
  return { errors, observed };
}

/**
 * Move a Draft item out of the creator's court.
 *
 * Procore's rule: an item is Draft until it is sent to its Punch Item Manager,
 * and a Draft item sits in its CREATOR's court. Everything this app creates is
 * therefore Draft — the API service account creates it, a real person is the
 * manager — which is why every imported item showed ball-in-court on
 * "ABS abs-api-export". That is the workflow behaving correctly, not a bad
 * payload; the item simply had not been sent.
 *
 * Sending is opt-in per push because it is what emails the manager and the
 * assignees. Sending sixty items silently would put sixty notifications in front
 * of people who never agreed to receive them.
 */
export async function sendPunchItem(
  projectId: number,
  punchItemId: number,
  before: ObservedPunchItem | null,
): Promise<{ sent: boolean; strategy: string | null; errors: string[]; observed: ObservedPunchItem | null }> {
  if (memo.sendFailure) {
    return { sent: false, strategy: null, errors: memo.sendFailure, observed: before };
  }

  const errors: string[] = [];
  const baseline = workflowSignature(before);

  for (const strategy of ordered(SEND_STRATEGIES, memo.send)) {
    try {
      await strategy.run(projectId, punchItemId);
      const after = await observePunchItem(projectId, punchItemId);
      if (after && (after.isDraft === false || workflowSignature(after) !== baseline)) {
        memo.send = strategy.label;
        return { sent: true, strategy: strategy.label, errors, observed: after };
      }
      errors.push(`${strategy.label}: accepted, but nothing about the item changed`);
    } catch (err) {
      errors.push(`${strategy.label}: ${describeError(err)}`);
    }
  }

  memo.sendFailure = errors;
  return { sent: false, strategy: null, errors, observed: before };
}

/**
 * Assignment strategies, tried in order until the read-back shows an assignee.
 *
 * Procore accepted the inline `assignments` array on create and stored nothing
 * from it. The accepted shape could not be confirmed from here — Procore's
 * developer docs are unreachable behind this environment's network egress
 * policy — so the chain runs only when the inline attempt demonstrably failed,
 * and reports which member worked so it can later collapse to that one.
 *
 * Nothing here runs when no assignee was chosen. An unassigned item is meant to
 * sit in nobody's court, and inventing an assignee to satisfy Procore's default
 * would put work in front of a person who never agreed to it.
 */
const ASSIGN_STRATEGIES: Array<WriteStrategy<[number[], number | null]>> = [
  {
    // Rails nested attributes. The plain `assignments` array on create was
    // accepted and stored nothing, which is exactly what a Rails controller does
    // with a nested collection that is not named `*_attributes`.
    label: 'PATCH assignments_attributes',
    run: async (projectId, punchItemId, assigneeIds, vendorId) => {
      await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
        body: {
          project_id: projectId,
          punch_item: {
            assignments_attributes: assigneeIds.map((id) => ({
              login_information_id: id,
              ...(vendorId ? { vendor_id: vendorId } : {}),
            })),
          },
        },
      });
    },
  },
  {
    // The nested path `/punch_items/{id}/punch_item_assignments` 404s with an
    // empty body, so it does not exist. Procore's flat-URL-with-query-param shape
    // is the same one that turned out to be correct for project_roles, where the
    // nested form also answered emptily.
    label: 'POST punch_item_assignments',
    run: async (projectId, punchItemId, assigneeIds, vendorId) => {
      for (const assigneeId of assigneeIds) {
        await procoreRequest('POST', '/rest/v1.1/punch_item_assignments', {
          query: { project_id: projectId },
          body: {
            project_id: projectId,
            punch_item_assignment: {
              punch_item_id: punchItemId,
              login_information_id: assigneeId,
              ...(vendorId ? { vendor_id: vendorId } : {}),
            },
          },
        });
      }
    },
  },
  {
    label: 'PATCH login_information_ids',
    run: async (projectId, punchItemId, assigneeIds) => {
      await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: { login_information_ids: assigneeIds } },
      });
    },
  },
];

/**
 * Make sure the requested assignee actually holds the item.
 *
 * Runs only when the create did not already achieve it, and only when an
 * assignee was chosen. An unassigned item is meant to sit in nobody's court —
 * inventing an assignee to satisfy a Procore default would put work in front of
 * a person who never agreed to it.
 */
export async function ensureAssignees(
  projectId: number,
  punchItemId: number,
  assigneeIds: number[],
  vendorId: number | null,
  observed: ObservedPunchItem | null,
): Promise<{ strategy: string | null; errors: string[]; observed: ObservedPunchItem | null }> {
  if (!assigneeIds.length) return { strategy: null, errors: [], observed };
  if (observed && observed.assignees.length > 0) {
    return { strategy: 'inline assignments on create', errors: [], observed };
  }
  if (memo.assignFailure) {
    return { strategy: null, errors: memo.assignFailure, observed };
  }

  const errors: string[] = [];
  for (const strategy of ordered(ASSIGN_STRATEGIES, memo.assign)) {
    try {
      await strategy.run(projectId, punchItemId, assigneeIds, vendorId);
      const after = await observePunchItem(projectId, punchItemId);
      if (after && after.assignees.length > 0) {
        memo.assign = strategy.label;
        return { strategy: strategy.label, errors, observed: after };
      }
      errors.push(`${strategy.label}: accepted but no assignee was stored`);
    } catch (err) {
      errors.push(`${strategy.label}: ${describeError(err)}`);
    }
  }

  memo.assignFailure = errors;
  return { strategy: null, errors, observed };
}

export interface CreatePunchItemResult {
  item: CreatedPunchItem;
  photoErrors: string[];
  photosAttached: number;
  assignErrors: string[];
  assignStrategy: string | null;
  sendErrors: string[];
  sendStrategy: string | null;
  observed: ObservedPunchItem | null;
}

/**
 * Create one punch item, then report what Procore actually stored.
 *
 * Nothing here trusts a 2xx. Three separate writes have been answered 200 by
 * Procore and stored nothing — attachments twice, assignees once — so the item is
 * read back and the report is built from the read, not from the response. A
 * photo that does not arrive degrades to "item created, photo missing", which is
 * recoverable in the field, rather than losing the row.
 */
export async function createPunchItem(
  projectId: number,
  input: PunchItemInput,
  photos: PunchPhoto[] = [],
  options: { send?: boolean } = {},
): Promise<CreatePunchItemResult> {
  const photoErrors: string[] = [];
  let created: CreatedPunchItem;

  if (photos.length) {
    try {
      created = await createWithPhotos(projectId, input, photos);
    } catch (err) {
      photoErrors.push(
        `photos rejected on create: ${
          err instanceof ProcoreError
            ? `${err.status} ${err.fieldErrors().join('; ') || summarize(err.body)}`
            : String(err)
        }`,
      );
      // Never lose the row over a photo — fall back to the plain JSON create.
      created = await procoreRequest<CreatedPunchItem>('POST', '/rest/v1.1/punch_items', {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: buildPunchItemPayload(input) },
      });
    }
  } else {
    created = await procoreRequest<CreatedPunchItem>('POST', '/rest/v1.1/punch_items', {
      query: { project_id: projectId },
      body: { project_id: projectId, punch_item: buildPunchItemPayload(input) },
    });
  }

  let observed = created?.id ? await observePunchItem(projectId, created.id) : null;

  // A 2xx on the create is not evidence the photos landed — three separate
  // attempts returned 200 and stored nothing. Only the read-back counts.
  if (photos.length && created?.id) {
    const attached = await ensurePhotos(projectId, created.id, photos, observed);
    observed = attached.observed ?? observed;
    photoErrors.push(...attached.errors);
  }
  const photosAttached = storedPhotos(observed);

  let assignErrors: string[] = [];
  let assignStrategy: string | null = null;
  if (created?.id) {
    const assigned = await ensureAssignees(
      projectId,
      created.id,
      input.assigneeIds || [],
      input.vendorId ?? null,
      observed,
    );
    assignStrategy = assigned.strategy;
    assignErrors = assigned.errors;
    observed = assigned.observed ?? observed;
  }

  // Attempt the send whenever it was asked for and the item is not already known
  // to have left Draft. `isDraft === null` means the workflow field could not be
  // identified, and unknown must fall through to trying — reading unknown as
  // "already sent" is exactly the bug that made the send silently do nothing.
  let sendErrors: string[] = [];
  let sendStrategy: string | null = null;
  if (options.send && created?.id && observed?.isDraft !== false) {
    const sent = await sendPunchItem(projectId, created.id, observed);
    sendErrors = sent.sent ? [] : sent.errors;
    sendStrategy = sent.strategy;
    observed = sent.observed ?? observed;
  }

  return {
    item: created,
    photoErrors,
    photosAttached,
    assignErrors,
    assignStrategy,
    sendErrors,
    sendStrategy,
    observed,
  };
}

/** Read punch items back — used by the probe and by duplicate detection. */
export async function listPunchItems(projectId: number): Promise<Array<Record<string, unknown>>> {
  return procorePaginate<Record<string, unknown>>('/rest/v1.1/punch_items', {
    query: { project_id: projectId },
  });
}
