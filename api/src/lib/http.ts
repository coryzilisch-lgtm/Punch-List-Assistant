import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

/**
 * Shared HTTP helpers. Every response is JSON and no-store: this app is a
 * short-lived working session (upload → review → push), so there is nothing
 * worth caching and a cached draft would be actively wrong.
 */

const NO_STORE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export function json(body: unknown, status = 200): HttpResponseInit {
  return { status, headers: NO_STORE, jsonBody: body };
}

export function errorResponse(status: number, message: string, extra?: Record<string, unknown>) {
  return json({ error: message, ...(extra || {}) }, status);
}

export interface ClientPrincipal {
  userId: string;
  userDetails: string; // email / UPN
  identityProvider: string;
  userRoles: string[];
}

/**
 * Parse the SWA-injected principal.
 *
 * ⚠️ This used to be described as "identity for attribution, not an access
 * gate", on the grounds that the route config already required `authenticated`.
 * That was true of the file and false of the deployment: `staticwebapp.config.json`
 * sat at the repo root while the workflow deploys `app_location: ./dashboard`,
 * so SWA never read it and **nothing was gated at all** — the dashboard and
 * every `/api/*` route, including the ones that write into live Procore
 * projects, were reachable by anyone with the URL.
 *
 * The file is in the right place now. It is also no longer the only thing
 * standing between an anonymous request and a punch item: `guarded()` refuses a
 * request with no principal, in code, where a misplaced config cannot silently
 * switch it off. This repo's whole discipline is that a 2xx is not evidence —
 * the same applies to a platform setting nobody has watched enforce anything.
 */
export function getPrincipal(request: HttpRequest): ClientPrincipal | null {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as ClientPrincipal;
    return parsed?.userDetails ? parsed : null;
  } catch {
    return null;
  }
}

export function userEmail(request: HttpRequest): string | null {
  return getPrincipal(request)?.userDetails?.toLowerCase() ?? null;
}

/** Read and parse a JSON request body, with a clear message when it is malformed. */
export async function readJson<T>(request: HttpRequest): Promise<T> {
  const text = await request.text();
  if (!text) throw new Error('Request body was empty');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Request body was not valid JSON');
  }
}

/**
 * Wrap a handler so an unexpected throw becomes a described error, not a bare 500.
 *
 * A 500 from the Functions host carries no body the app can show, so it reaches
 * the user as "something failed" and reaches the developer as nothing at all.
 * Every handler here already catches the failures it anticipates; this catches
 * the ones it does not, which are exactly the ones worth seeing.
 */
export function guarded(
  name: string,
  handler: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>,
) {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    // Defence in depth, and the lesson of this bug: the SWA route rules are the
    // front door, but they live in a file that was in the wrong folder for the
    // life of this app without anyone noticing. A request that arrives without
    // an identity does not get to create punch items, whatever the platform
    // thinks.
    //
    // Note this also 401s a local `func start`, which has no SWA principal to
    // inject. That is deliberate — an env flag to bypass an auth check is how
    // auth checks get bypassed in production.
    if (!getPrincipal(request)) {
      context.warn(`${name} refused an unauthenticated request`);
      return errorResponse(
        401,
        'You are not signed in. Reload the page to sign in with your Buffalo account.',
        { signInUrl: '/.auth/login/aad' },
      );
    }

    try {
      return await handler(request, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      context.error(`${name} threw: ${message}\n${stack ?? ''}`);
      return errorResponse(500, `${name} failed unexpectedly: ${message}`, { handler: name });
    }
  };
}
