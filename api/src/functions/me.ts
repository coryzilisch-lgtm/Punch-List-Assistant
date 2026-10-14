import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { getPrincipal, json } from '../lib/http';
import { procoreConfigured, procoreSettingProblems } from '../lib/procore';
import { sessionFromCookie } from '../lib/procore-session';

/**
 * GET /api/me — who is signed in. Used for attribution (the reference stamped
 * on each pushed punch item) and to greet the user. The SWA route config is the
 * access gate; this endpoint just reports identity.
 */
export async function meHandler(request: HttpRequest): Promise<HttpResponseInit> {
  const principal = getPrincipal(request);
  if (!principal) return json({ signedIn: false }, 401);
  // Whether this super has connected Procore in this browser. Items are created
  // as them, so the dashboard asks them to connect before anything else.
  const session = sessionFromCookie(request.headers.get('cookie'), principal.userId, Date.now());
  return json({
    signedIn: true,
    email: principal.userDetails,
    identityProvider: principal.identityProvider,
    procore: {
      configured: procoreConfigured(),
      // Setting NAMES only, never values: what to fix in the Azure portal.
      settingProblems: procoreSettingProblems(),
      // Where Procore sends the super back after sign-in. The dashboard compares
      // it with the address it is open on: a mismatch means the sign-in cookie
      // and the session land on a different site and connecting cannot work.
      callbackHost: callbackHost(),
      connected: Boolean(session),
      name: session?.name ?? null,
      login: session?.login ?? null,
      expiresAt: session?.expiresAt ?? null,
    },
  });
}

function callbackHost(): string | null {
  try {
    return new URL((process.env.PROCORE_REDIRECT_URI || '').trim()).host || null;
  } catch {
    return null;
  }
}

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: meHandler,
});
