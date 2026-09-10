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

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const reset = Number(res.headers.get('X-Rate-Limit-Reset') || 0);
      const waitMs = reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : backoffMs(attempt);
      await sleep(Math.min(waitMs, 60_000));
      continue;
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

  // Assignments carry the ball-in-court. Procore accepts a list so an item can
  // go to several people; the UI sends one in practice.
  const assignees = input.assigneeIds || [];
  if (assignees.length || input.vendorId) {
    item.assignments = assignees.length
      ? assignees.map((id) => ({
          assignee_id: id,
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
  status: string | null;
  attachmentCount: number;
  ballInCourt: string[];
  assignees: string[];
  punchItemManager: string | null;
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
      // Assignment rows nest the person; plain user rows carry the name directly.
      return nameOf(e?.assignee ?? e?.user ?? e?.vendor ?? entry);
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
    return {
      status: typeof row.status === 'string' ? row.status : null,
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
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
 * Send the photos with the CREATE, not as a follow-up update.
 *
 * The first attempt attached afterwards with a multipart PATCH, on the reasoning
 * that a rejected photo should not cost the whole item. Procore accepted every
 * one of those requests with a 200 and stored nothing: `images[]` is documented
 * on **Create Punch Item**, and the update endpoint simply ignores it. Photos
 * therefore go on the create.
 *
 * The original concern still stands, so it is handled by falling back: if the
 * multipart create fails for any reason, the item is created again from the
 * plain JSON body that is already known to work, and the photo failure is
 * reported against a row that exists rather than losing the row.
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
      'images[]',
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
const SEND_STRATEGIES: Array<{ label: string; send: (p: number, id: number) => Promise<void> }> = [
  {
    label: 'PATCH status=initiated',
    send: (projectId, id) =>
      procoreRequest('PATCH', `/rest/v1.1/punch_items/${id}`, {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: { status: 'initiated' } },
      }).then(() => undefined),
  },
  {
    label: 'POST send',
    send: (projectId, id) =>
      procoreRequest('POST', `/rest/v1.1/punch_items/${id}/send`, {
        query: { project_id: projectId },
        body: { project_id: projectId },
      }).then(() => undefined),
  },
];

export async function sendPunchItem(
  projectId: number,
  punchItemId: number,
): Promise<{ sent: boolean; strategy: string | null; errors: string[] }> {
  const errors: string[] = [];
  for (const strategy of SEND_STRATEGIES) {
    try {
      await strategy.send(projectId, punchItemId);
      const after = await observePunchItem(projectId, punchItemId);
      if (after && after.status && after.status.toLowerCase() !== 'draft') {
        return { sent: true, strategy: strategy.label, errors };
      }
      errors.push(`${strategy.label}: accepted but the item is still Draft`);
    } catch (err) {
      errors.push(
        `${strategy.label}: ${
          err instanceof ProcoreError
            ? `${err.status} ${err.fieldErrors().join('; ') || summarize(err.body)}`
            : String(err)
        }`,
      );
    }
  }
  return { sent: false, strategy: null, errors };
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
const ASSIGN_STRATEGIES: Array<{
  label: string;
  send: (projectId: number, punchItemId: number, assigneeIds: number[], vendorId: number | null) => Promise<void>;
}> = [
  {
    label: 'POST punch_item_assignments',
    send: async (projectId, punchItemId, assigneeIds, vendorId) => {
      for (const assigneeId of assigneeIds) {
        await procoreRequest('POST', `/rest/v1.1/punch_items/${punchItemId}/punch_item_assignments`, {
          query: { project_id: projectId },
          body: {
            project_id: projectId,
            punch_item_assignment: {
              assignee_id: assigneeId,
              ...(vendorId ? { vendor_id: vendorId } : {}),
            },
          },
        });
      }
    },
  },
  {
    label: 'PATCH assignee_ids',
    send: async (projectId, punchItemId, assigneeIds) => {
      await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
        query: { project_id: projectId },
        body: { project_id: projectId, punch_item: { assignee_ids: assigneeIds } },
      });
    },
  },
];

/**
 * Make sure the requested assignee actually holds the item, retrying through the
 * strategies above only if the create did not already achieve it.
 */
export async function ensureAssignees(
  projectId: number,
  punchItemId: number,
  assigneeIds: number[],
  vendorId: number | null,
  observed: ObservedPunchItem | null,
): Promise<{ strategy: string | null; errors: string[]; observed: ObservedPunchItem | null }> {
  const errors: string[] = [];
  if (!assigneeIds.length) return { strategy: null, errors, observed };
  if (observed && observed.assignees.length > 0) {
    return { strategy: 'inline assignments on create', errors, observed };
  }

  for (const strategy of ASSIGN_STRATEGIES) {
    try {
      await strategy.send(projectId, punchItemId, assigneeIds, vendorId);
      const after = await observePunchItem(projectId, punchItemId);
      if (after && after.assignees.length > 0) {
        return { strategy: strategy.label, errors, observed: after };
      }
      errors.push(`${strategy.label}: accepted but no assignee was stored`);
    } catch (err) {
      errors.push(
        `${strategy.label}: ${
          err instanceof ProcoreError
            ? `${err.status} ${err.fieldErrors().join('; ') || summarize(err.body)}`
            : String(err)
        }`,
      );
    }
  }

  return { strategy: null, errors, observed };
}

export interface CreatePunchItemResult {
  item: CreatedPunchItem;
  photoErrors: string[];
  photosAttached: number;
  assignErrors: string[];
  assignStrategy: string | null;
  sendErrors: string[];
  observed: ObservedPunchItem | null;
}

/**
 * Create one punch item, then attach its photos and report what Procore stored.
 *
 * Attachments go in a SECOND request on purpose. Procore accepts images on
 * create, but then a photo it rejects (size, type) fails the whole item and the
 * superintendent loses the row. Creating first means a photo failure degrades to
 * "item created, photo missing" — recoverable in the field — and it is reported
 * per item rather than silently swallowed.
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

  // A 2xx on the create is not evidence the photos landed; the previous attempt
  // returned 200 and stored nothing. Only the read-back counts.
  const photosAttached = observed?.attachmentCount ?? 0;
  if (photos.length && photosAttached === 0 && !photoErrors.length) {
    photoErrors.push('Procore accepted the create but stored no attachment');
  }

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

  let sendErrors: string[] = [];
  if (options.send && created?.id && observed?.status?.toLowerCase() === 'draft') {
    const sent = await sendPunchItem(projectId, created.id);
    sendErrors = sent.sent ? [] : sent.errors;
    observed = (await observePunchItem(projectId, created.id)) ?? observed;
  }

  return {
    item: created,
    photoErrors,
    photosAttached,
    assignErrors,
    assignStrategy,
    sendErrors,
    observed,
  };
}

/** Read punch items back — used by the probe and by duplicate detection. */
export async function listPunchItems(projectId: number): Promise<Array<Record<string, unknown>>> {
  return procorePaginate<Record<string, unknown>>('/rest/v1.1/punch_items', {
    query: { project_id: projectId },
  });
}
