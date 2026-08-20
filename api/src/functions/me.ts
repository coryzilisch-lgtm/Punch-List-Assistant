import { app, HttpRequest, HttpResponseInit } from '@azure/functions';
import { getPrincipal, json } from '../lib/http';

/**
 * GET /api/me — who is signed in. Used for attribution (the reference stamped
 * on each pushed punch item) and to greet the user. The SWA route config is the
 * access gate; this endpoint just reports identity.
 */
export async function meHandler(request: HttpRequest): Promise<HttpResponseInit> {
  const principal = getPrincipal(request);
  if (!principal) return json({ signedIn: false }, 401);
  return json({
    signedIn: true,
    email: principal.userDetails,
    identityProvider: principal.identityProvider,
  });
}

app.http('me', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'me',
  handler: meHandler,
});
