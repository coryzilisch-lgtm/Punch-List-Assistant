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

/** Paginate a v1.x list endpoint (bare-array response). */
export async function procorePaginate<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  perPage = 100,
): Promise<T[]> {
  const out: T[] = [];
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
    if (rows.length < perPage) break;
  }
  return out;
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

export async function listProjects(): Promise<ProcoreProject[]> {
  return procorePaginate<ProcoreProject>('/rest/v1.1/projects', {
    query: { company_id: companyId() },
  });
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
 * Create one punch item, then attach its photos.
 *
 * Attachments go in a SECOND request on purpose. Procore accepts multipart on
 * create, but then a photo that Procore rejects (size, type) fails the whole
 * item and the super loses the row entirely. Creating first means a photo
 * failure degrades to "item created, photo missing" — which is recoverable in
 * the field — and it is reported per-item rather than silently swallowed.
 */
export async function createPunchItem(
  projectId: number,
  input: PunchItemInput,
  photos: PunchPhoto[] = [],
): Promise<{ item: CreatedPunchItem; photoErrors: string[] }> {
  const created = await procoreRequest<CreatedPunchItem>('POST', '/rest/v1.1/punch_items', {
    query: { project_id: projectId },
    body: { project_id: projectId, punch_item: buildPunchItemPayload(input) },
  });

  const photoErrors: string[] = [];
  if (photos.length && created?.id) {
    for (const photo of photos) {
      try {
        await attachPhoto(projectId, created.id, photo);
      } catch (err) {
        photoErrors.push(
          err instanceof ProcoreError
            ? `${photo.filename}: ${err.status} ${err.fieldErrors().join('; ') || summarize(err.body)}`
            : `${photo.filename}: ${String(err)}`,
        );
      }
    }
  }

  return { item: created, photoErrors };
}

/** Attach one image to an existing punch item via multipart PATCH. */
export async function attachPhoto(
  projectId: number,
  punchItemId: number,
  photo: PunchPhoto,
): Promise<void> {
  const form = new FormData();
  form.append('project_id', String(projectId));
  form.append(
    'punch_item[attachments][]',
    new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }),
    photo.filename,
  );

  await procoreRequest('PATCH', `/rest/v1.1/punch_items/${punchItemId}`, {
    query: { project_id: projectId },
    form,
  });
}

/** Read punch items back — used by the probe and by duplicate detection. */
export async function listPunchItems(projectId: number): Promise<Array<Record<string, unknown>>> {
  return procorePaginate<Record<string, unknown>>('/rest/v1.1/punch_items', {
    query: { project_id: projectId },
  });
}
