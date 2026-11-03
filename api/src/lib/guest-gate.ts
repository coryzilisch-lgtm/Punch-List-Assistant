import type { HttpRequest, HttpResponseInit, PreInvocationContext } from '@azure/functions';

/**
 * Refuse guest accounts on every API route, whatever Entra lets through.
 *
 * Entra's "Assignment required" on the enterprise app is the first line, and it
 * is consulted at sign-in only: an SWA session cookie is a self-contained ticket
 * that outlives the setting, and on The Range (Nov 2 2026) IT's guest account
 * still had a working session after the setting was on. So every Buffalo app
 * checks for itself, on every request, in code. Two lines, not one.
 *
 * Two checks:
 *
 * 1. The token's claims (pure, free): a `#EXT#` name (every B2B guest's UPN is
 *    rewritten to that form), an `idp` / identityprovider claim naming anything
 *    but this tenant (a member of the tenant has no idp claim), or `acct` = 1.
 *
 * 2. The directory: ask Microsoft Graph for the account's `userType` with an
 *    app-only token (client credentials on AZURE_TENANT_ID / AZURE_CLIENT_ID /
 *    AZURE_CLIENT_SECRET, the service principal the app already has). Entra's
 *    own answer, so it does not depend on which claims SWA forwards. Needs the
 *    `User.Read.All` application permission on that registration; without it
 *    the lookup fails, is logged, and the claims decide. Cached an hour per oid
 *    per instance. A Graph failure fails OPEN for five minutes (an outage must
 *    not lock the company out).
 *
 * Machine callers with a key and no SWA principal are never checked.
 *
 * Same file in every Buffalo app repo (The Range keeps the JS original in
 * api/lib/guest-gate.js); change it in all of them.
 */

export const TENANT_ID = process.env.AZURE_TENANT_ID || '765713ef-2ac8-4410-98f0-08ea9552c506';
const GRAPH_CACHE_MS = 60 * 60 * 1000;
const GRAPH_ERROR_MS = 5 * 60 * 1000;

export type Claim = { typ?: string; val?: string };
export type Principal = {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  userRoles?: string[];
  claims?: Claim[];
} | null;

export function parsePrincipal(request: HttpRequest): Principal {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Principal;
  } catch {
    return null;
  }
}

function claimVal(claims: Claim[], ...types: string[]): string | null {
  for (const typ of types) {
    const hit = claims.find(
      (c) => c && typeof c.typ === 'string' && (c.typ === typ || c.typ.toLowerCase().endsWith('/' + typ)),
    );
    if (hit && hit.val != null && hit.val !== '') return String(hit.val);
  }
  return null;
}

function idpIsHomeTenant(idp: string, tenantId: string): boolean {
  const t = String(tenantId || '').toLowerCase();
  const v = String(idp || '').toLowerCase();
  return !!t && (v === `https://sts.windows.net/${t}/` || v === `https://login.microsoftonline.com/${t}/v2.0`);
}

export type GuestReason = 'ext-upn' | 'external-idp' | 'acct-guest' | 'graph-guest';

/** Why this principal is a guest by its claims, or null for a member of the tenant. */
export function guestReason(principal: Principal, tenantId: string = TENANT_ID): GuestReason | null {
  if (!principal) return null;
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const names = [
    principal.userDetails,
    claimVal(claims, 'upn'),
    claimVal(claims, 'preferred_username'),
    claimVal(claims, 'emailaddress'),
    claimVal(claims, 'email'),
    claimVal(claims, 'unique_name'),
    claimVal(claims, 'name'),
  ];
  if (names.some((n) => /#EXT#/i.test(n || ''))) return 'ext-upn';
  const idp = claimVal(claims, 'identityprovider', 'idp');
  if (idp && !idpIsHomeTenant(idp, tenantId)) return 'external-idp';
  if (claimVal(claims, 'acct') === '1') return 'acct-guest';
  return null;
}

/** The Entra object id on the principal. SWA's own `userId` is NOT it (an SWA-generated id). */
export function principalOid(principal: Principal): string | null {
  if (!principal) return null;
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const oid = claimVal(claims, 'objectidentifier', 'oid');
  return oid && /^[0-9a-f-]{36}$/i.test(oid) ? oid.toLowerCase() : null;
}

export type GraphDeps = {
  fetchUserType?: (oid: string) => Promise<string | null>;
  now?: () => number;
  warn?: (message: string) => void;
};

const graphCache = new Map<string, { until: number; reason: GuestReason | null }>();

/** Ask the directory. 'graph-guest', or null (member, or Graph could not say). */
export async function graphGuestReason(principal: Principal, deps: GraphDeps = {}): Promise<GuestReason | null> {
  const oid = principalOid(principal);
  if (!oid) return null;
  const now = deps.now ? deps.now() : Date.now();
  const hit = graphCache.get(oid);
  if (hit && hit.until > now) return hit.reason;
  if (graphCache.size > 2000) graphCache.clear();
  const fetchUserType = deps.fetchUserType || defaultFetchUserType;
  try {
    const userType = await fetchUserType(oid);
    const reason: GuestReason | null = String(userType || '').toLowerCase() === 'guest' ? 'graph-guest' : null;
    graphCache.set(oid, { until: now + GRAPH_CACHE_MS, reason });
    return reason;
  } catch (err) {
    (deps.warn || console.warn)(
      `guest gate: Graph lookup failed for ${oid}, letting the claims decide: ${(err as Error)?.message ?? err}`,
    );
    graphCache.set(oid, { until: now + GRAPH_ERROR_MS, reason: null });
    return null;
  }
}

export function _resetGraphCache(): void {
  graphCache.clear();
}

let appToken: { token: string; exp: number } | null = null;

async function getAppToken(): Promise<string> {
  if (appToken && Date.now() < appToken.exp) return appToken.token;
  const tenant = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const secret = process.env.AZURE_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) {
    throw new Error('AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are not all set, directory check off');
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return appToken.token;
}

async function defaultFetchUserType(oid: string): Promise<string | null> {
  const token = await getAppToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${oid}?$select=id,userType`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  // A 404 is an account this tenant does not know at all: the claims check
  // already had its say. Treat as "could not say".
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Graph ${res.status}${res.status === 403 ? ' (does the app registration have User.Read.All?)' : ''}`);
  }
  const u = (await res.json()) as { userType?: string };
  return u && u.userType ? u.userType : null;
}

export function rejectedResponse(appName: string): HttpResponseInit {
  return {
    status: 403,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    jsonBody: { error: 'guest', message: `${appName} is for Buffalo employees. Guest accounts can't use it.` },
  };
}

type AppLike = { hook: { preInvocation: (handler: (ctx: PreInvocationContext) => void | Promise<void>) => void } };

/**
 * Register the gate as a preInvocation hook: it runs before EVERY function's
 * handler, so a route cannot forget it. Call once from the entry point, before
 * the function modules are imported.
 */
export function registerGuestGate(app: AppLike, appName: string): void {
  app.hook.preInvocation(async (ctx) => {
    const req = ctx.inputs && (ctx.inputs[0] as HttpRequest | undefined);
    if (!req || typeof req.method !== 'string' || !req.headers || typeof req.headers.get !== 'function') return;
    const principal = parsePrincipal(req);
    if (!principal) return;
    const warn = (m: string) => ctx.invocationContext.warn(m);
    const guest = guestReason(principal) || (await graphGuestReason(principal, { warn }));
    if (!guest) return;
    // Claim TYPES only, never values: enough to diagnose a false positive from the log.
    const types = (principal.claims || []).map((c) => c && c.typ).filter(Boolean).join(',');
    let path = req.url;
    try { path = new URL(req.url).pathname; } catch { /* keep the raw url */ }
    warn(`guest account refused: ${req.method} ${path} (${guest}; claims: ${types})`);
    ctx.functionHandler = async () => rejectedResponse(appName);
  });
}
