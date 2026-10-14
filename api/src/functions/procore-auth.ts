import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cookie } from '@azure/functions';
import { errorResponse, getPrincipal, guarded, json } from '../lib/http';
import { authorizeUrl, exchangeCode, procoreConfigured, procoreNotConfiguredMessage, ProcoreError, procoreRequest } from '../lib/procore';
import {
  MAX_COOKIE_BYTES,
  newState,
  ProcoreSession,
  readCookie,
  runAsProcoreUser,
  seal,
  SESSION_COOKIE,
  STATE_COOKIE,
  ownerFromState,
} from '../lib/procore-session';

/**
 * Connecting a superintendent's Procore account: Procore's user-level OAuth
 * (authorization code), in a popup so a reconnect mid-review loses nothing.
 *
 *   GET  /api/procore/connect     → Procore's login page, with a state bound to this Entra user
 *   GET  /api/procore/callback    → swap the code for the super's token, set the session cookie
 *   POST /api/procore/disconnect  → drop it
 *
 * Connect and disconnect sit behind the Entra gate like everything else. The
 * callback cannot rely on it: it arrives as a redirect from procore.com, and
 * whether the browser sends SWA's login cookie cross-site is not this app's to
 * decide. So the callback is anonymous at the platform and proves itself with
 * the sealed `state` cookie instead: set by /connect for one signed-in Entra
 * user, encrypted, single use, ten minutes. The session it creates is bound to
 * that user, and every later request checks it against the SWA principal.
 */

const cookieBase = { path: '/api', httpOnly: true, secure: true, sameSite: 'Lax' as const };

export async function connectHandler(request: HttpRequest): Promise<HttpResponseInit> {
  if (!procoreConfigured()) return errorResponse(503, procoreNotConfiguredMessage());
  const owner = getPrincipal(request)!.userId;
  const { state, sealed } = newState(owner);
  return {
    status: 302,
    headers: { Location: authorizeUrl(state), 'Cache-Control': 'no-store' },
    cookies: [{ ...cookieBase, path: '/api/procore', name: STATE_COOKIE, value: sealed, maxAge: 600 }],
  };
}

export async function callbackHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const clearState: Cookie = { ...cookieBase, path: '/api/procore', name: STATE_COOKIE, value: '', maxAge: 0 };
  const done = (ok: boolean, message: string, cookies: Cookie[] = []) => ({
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    cookies: [clearState, ...cookies],
    body: resultPage(ok, message),
  });

  const denied = request.query.get('error');
  if (denied) return done(false, `Procore did not connect: ${request.query.get('error_description') || denied}.`);

  // The state must be the one this browser was given, under ten minutes old.
  // Anything else is a forged, replayed or stale callback.
  const owner = ownerFromState(readCookie(request.headers.get('cookie'), STATE_COOKIE), request.query.get('state'), Date.now());
  if (!owner) {
    return done(false, 'That Procore sign-in had expired or did not start here. Close this window and press Connect Procore again.');
  }
  // When the platform did pass the sign-in through, it must be the same person.
  const principal = getPrincipal(request);
  if (principal && principal.userId !== owner) {
    return done(false, 'This Procore sign-in was started by a different Buffalo account. Close this window and try again.');
  }
  if (!procoreConfigured()) return done(false, procoreNotConfiguredMessage());
  const code = request.query.get('code');
  if (!code) return done(false, 'Procore sent no authorization code. Close this window and try again.');

  try {
    const { accessToken, expiresIn } = await exchangeCode(code);
    const expiresAt = Date.now() + expiresIn * 1000;

    // Ask Procore who this token is: the name shown as "Connected as", and the
    // proof the token works before anything relies on it.
    const draft: ProcoreSession = { accessToken, expiresAt, owner, procoreUserId: null, name: null, login: null };
    const me = await runAsProcoreUser(draft, () => procoreRequest<Record<string, unknown>>('GET', '/rest/v1.0/me'));
    // The first live connect came back with no usable name (2026-10-14), so read
    // every plausible field, and log which ones exist (names only, never values)
    // so the real shape is on record.
    context.log(`procore /me fields: ${Object.keys(me || {}).sort().join(',')}`);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const joined = [str(me?.first_name), str(me?.last_name)].filter(Boolean).join(' ') || null;
    const login = str(me?.login) || str(me?.email_address) || str(me?.email);
    const session: ProcoreSession = {
      ...draft,
      procoreUserId: typeof me?.id === 'number' ? me.id : Number(me?.id) || null,
      name: str(me?.name) || joined || login,
      login,
    };

    const value = seal(session);
    // A browser drops an oversized cookie without a word; say so instead.
    if (value.length > MAX_COOKIE_BYTES) {
      context.error(`procore callback: session cookie would be ${value.length} bytes, over ${MAX_COOKIE_BYTES}`);
      return done(false, "Procore's token is too large for this app to keep. Tell Cory: the session needs server-side storage.");
    }

    context.log(`procore connected: procore_user=${session.procoreUserId} login=${session.login}`);
    return done(true, `Connected to Procore as ${session.name || 'you'}.`, [
      { ...cookieBase, name: SESSION_COOKIE, value, maxAge: Math.max(60, expiresIn - 60) },
    ]);
  } catch (err) {
    const detail = err instanceof ProcoreError ? `HTTP ${err.status}: ${err.fieldErrors().join('; ') || err.message}` : String(err);
    context.error(`procore callback failed: ${detail}`);
    return done(false, `Procore refused the connection (${detail}). Close this window and try again.`);
  }
}

export async function disconnectHandler(): Promise<HttpResponseInit> {
  return {
    ...json({ connected: false }),
    cookies: [{ ...cookieBase, name: SESSION_COOKIE, value: '', maxAge: 0 }],
  };
}

/**
 * The popup's last page. Its script (a file, because the CSP allows no inline
 * script) tells the app's tab the result and closes the popup.
 */
function resultPage(ok: boolean, message: string): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Procore</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body data-ok="${ok}" data-message="${esc(message)}" style="font-family:system-ui,sans-serif;padding:24px">
<p>${esc(message)}</p><p><a href="/">Back to Punch List Assistant</a></p>
<script src="/procore-connected.js"></script></body></html>`;
}

app.http('procoreConnect', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config and guarded() require an authenticated user
  route: 'procore/connect',
  handler: guarded('procoreConnect', connectHandler),
});

app.http('procoreCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'procore/callback',
  // Not guarded(): see the note at the top. ownerFromState() is the gate here.
  handler: async (request, context) => {
    try {
      return await callbackHandler(request, context);
    } catch (err) {
      context.error(`procoreCallback threw: ${err instanceof Error ? err.stack : String(err)}`);
      return errorResponse(500, 'Connecting Procore failed unexpectedly. Close this window and try again.');
    }
  },
});

app.http('procoreDisconnect', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'procore/disconnect',
  handler: guarded('procoreDisconnect', disconnectHandler),
});
