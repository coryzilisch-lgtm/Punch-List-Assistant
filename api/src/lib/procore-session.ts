import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Who this request talks to Procore as: the signed-in superintendent.
 *
 * Every Procore call runs on the super's own token, from Procore's user-level
 * OAuth (authorization code). There is deliberately **no fallback** to a service
 * account (decided by Cory, 2026-10-14): an item created by a robot was the
 * confusion this replaces. A Draft sits in its creator's court, so items created
 * as the super wait on the super; permissions are Procore's own; and the audit
 * trail names who did the work.
 *
 * The token lives in one encrypted, HttpOnly cookie, for one session (~2 hours,
 * Procore's access-token lifetime). No refresh token is kept anywhere: that
 * removes a stored long-lived credential and the refresh-rotation race that
 * would silently sign people out mid-push. The cost is a one-click reconnect
 * when it expires.
 *
 * The cookie is bound to the Entra identity that created it. A cookie lifted
 * into somebody else's browser session does not work for them.
 */

export interface ProcoreSession {
  /** Procore access token. Never logged, never returned to the browser. */
  accessToken: string;
  /** Epoch ms when Procore said the token expires. */
  expiresAt: number;
  /** The Entra object id (SWA `userId`) this session belongs to. */
  owner: string;
  /** Procore's id for the super, from `/me`. */
  procoreUserId: number | null;
  /** The super's name as Procore shows it, for "Connected as …". */
  name: string | null;
  login: string | null;
}

const als = new AsyncLocalStorage<ProcoreSession | null>();

/** Run `fn` with every Procore request made as this super. */
export function runAsProcoreUser<T>(session: ProcoreSession | null, fn: () => Promise<T>): Promise<T> {
  return als.run(session, fn);
}

/**
 * A stable key for whoever this request acts as. Anything remembered from a
 * Procore answer (a cache entry, a list path, a write strategy that failed) is
 * keyed by it: answers come back filtered by THAT super's permissions, and one
 * super's 403 is not a fact about anybody else.
 */
export function actorKey(): string {
  const s = als.getStore();
  return s ? `u${s.procoreUserId ?? s.owner}` : 'anon';
}

/** The super this request acts as, or null when they have not connected Procore. */
export function currentProcoreSession(): ProcoreSession | null {
  return als.getStore() ?? null;
}

/**
 * The super has not connected Procore, or their token expired or was refused.
 * Procore answers a 401 before doing anything, so nothing was written.
 */
export class ProcoreConnectRequired extends Error {
  constructor(readonly reason: 'not-connected' | 'expired') {
    super(
      reason === 'expired'
        ? 'Your Procore connection has expired. Reconnect Procore, then try again. Nothing was written.'
        : 'Connect your Procore account first. Items are created as you, so the app needs your Procore login.',
    );
    this.name = 'ProcoreConnectRequired';
  }
}

// ── The cookie ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'pla_procore';
export const STATE_COOKIE = 'pla_procore_state';
/** Browsers drop a cookie over ~4 KB silently; refuse loudly instead. */
export const MAX_COOKIE_BYTES = 3800;

/**
 * The encryption key, from `PROCORE_SESSION_KEY`. Hashed so any long random
 * string works; too short is refused rather than quietly weak.
 */
export function sessionKey(): Buffer {
  const raw = process.env.PROCORE_SESSION_KEY || '';
  if (raw.length < 32) throw new Error('PROCORE_SESSION_KEY must be set to a random string of at least 32 characters');
  return createHash('sha256').update(raw).digest();
}

/** AES-256-GCM, so a tampered or forged cookie fails to open rather than decoding to garbage. */
export function seal(value: unknown, key: Buffer = sessionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal<T>(sealed: string, key: Buffer = sessionKey()): T | null {
  try {
    const buf = Buffer.from(sealed, 'base64url');
    if (buf.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Read one cookie from a request's Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The session in this request's cookie, if it is genuine, unexpired and belongs
 * to the Entra user making the request. Anything else is "not connected".
 */
export function sessionFromCookie(cookieHeader: string | null | undefined, owner: string, now: number): ProcoreSession | null {
  const sealed = readCookie(cookieHeader, SESSION_COOKIE);
  if (!sealed || !process.env.PROCORE_SESSION_KEY) return null;
  const session = unseal<ProcoreSession>(sealed);
  if (!session || typeof session.accessToken !== 'string') return null;
  if (session.owner !== owner) return null;
  // A minute of margin, so a token does not expire between the check and the call.
  if (!(session.expiresAt > now + 60_000)) return null;
  return session;
}

/** A random OAuth `state`, bound to the owner so a callback cannot be replayed into another session. */
export function newState(owner: string): { state: string; sealed: string } {
  const state = randomBytes(24).toString('base64url');
  return { state, sealed: seal({ state, owner, at: Date.now() }) };
}

/**
 * The Entra user who started this connection, if the callback's `state` is the
 * one this browser was given, sealed by this app, under ten minutes old.
 * Anything else is a forged, replayed or stale callback, and gets null.
 *
 * The callback takes its identity from here rather than from the SWA sign-in
 * cookie, because it arrives as a redirect FROM procore.com, and whether a
 * browser sends the platform's login cookie on a cross-site redirect depends on
 * a SameSite setting this app does not control.
 */
export function ownerFromState(sealed: string | null, returned: string | null, now: number): string | null {
  if (!sealed || !returned) return null;
  const saved = unseal<{ state: string; owner: string; at: number }>(sealed);
  if (!saved || typeof saved.owner !== 'string' || now - saved.at > 10 * 60_000) return null;
  const a = Buffer.from(saved.state);
  const b = Buffer.from(returned);
  return a.length === b.length && timingSafeEqual(a, b) ? saved.owner : null;
}
