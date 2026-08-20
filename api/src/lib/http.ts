import type { HttpRequest, HttpResponseInit } from '@azure/functions';

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
 * Parse the SWA-injected principal. The route config already requires
 * `authenticated`, so this is identity for attribution (who imported what),
 * not an access gate.
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
