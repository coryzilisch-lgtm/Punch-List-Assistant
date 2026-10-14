import type { Cookie } from '@azure/functions';
import { deleteLink, LinkConflict, linkStoreConfigured, readLink, writeLink } from './link-store';
import { ProcoreError, refreshAccessToken } from './procore';
import { MAX_COOKIE_BYTES, ProcoreSession, seal, SESSION_COOKIE, unseal } from './procore-session';

/**
 * The permanent Procore link (Cory, 2026-10-14): connect once, stay connected.
 *
 * The session cookie still carries the ~2 hour access token, exactly as before.
 * What is new is what happens when it runs out: instead of asking the super to
 * reconnect, the request that finds no session reads their stored link, swaps
 * the refresh token for a new access token, and sets a fresh cookie. The super
 * notices nothing.
 *
 * Three rules keep it honest:
 *  - A refresh is a compare-and-swap. Two tabs refreshing at once must not
 *    leave the loser holding a refresh token the winner already spent, which
 *    would sign the super out at random. The loser re-reads and uses the
 *    winner's token.
 *  - A refresh Procore refuses (revoked access, a password change, a removed
 *    user) deletes the link. Retrying a dead token every request would only
 *    spend quota.
 *  - Anything else that fails (storage down, Procore 5xx) keeps the link and
 *    treats this one request as not connected. Nothing is written to Procore
 *    on a request that has no session.
 */

interface StoredLink extends ProcoreSession {
  refreshToken: string;
}

export const sessionCookieBase = { path: '/api', httpOnly: true, secure: true, sameSite: 'Lax' as const };

/** The session cookie for `session`, or null if it is too big for a browser to keep. */
export function sessionCookie(session: ProcoreSession, now = Date.now()): Cookie | null {
  const value = seal(session);
  if (value.length > MAX_COOKIE_BYTES) return null;
  return { ...sessionCookieBase, name: SESSION_COOKIE, value, maxAge: Math.max(60, Math.floor((session.expiresAt - now) / 1000) - 60) };
}

export const clearSessionCookie: Cookie = { ...sessionCookieBase, name: SESSION_COOKIE, value: '', maxAge: 0 };

const fresh = (s: ProcoreSession, now: number) => s.expiresAt > now + 60_000;

function open(sealed: string, owner: string): StoredLink | null {
  const link = unseal<StoredLink>(sealed);
  if (!link || link.owner !== owner || typeof link.refreshToken !== 'string') return null;
  return link;
}

const toSession = ({ refreshToken: _r, ...session }: StoredLink): ProcoreSession => session;

/** Keep the super linked: store what a later request needs to reconnect them. */
export async function saveLink(session: ProcoreSession, refreshToken: string): Promise<void> {
  await writeLink(session.owner, seal({ ...session, refreshToken } satisfies StoredLink));
}

/**
 * A working session for this Entra user from their stored link, refreshing it
 * if the stored access token has run out. Null when they have no link, or it
 * could not be used.
 */
export async function restoreSession(owner: string, now = Date.now()): Promise<ProcoreSession | null> {
  if (!linkStoreConfigured()) return null;
  const row = await readLink(owner);
  if (!row) return null;
  const link = open(row.sealed, owner);
  if (!link) return null;
  if (fresh(link, now)) return toSession(link);

  let tokens;
  try {
    tokens = await refreshAccessToken(link.refreshToken);
  } catch (err) {
    if (err instanceof ProcoreError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      // Procore refused the refresh token itself: the link is dead.
      await deleteLink(owner).catch(() => {});
      return null;
    }
    throw err;
  }

  const next: StoredLink = {
    ...link,
    accessToken: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1000,
    refreshToken: tokens.refreshToken ?? link.refreshToken,
  };
  try {
    await writeLink(owner, seal(next), row.etag);
    return toSession(next);
  } catch (err) {
    if (!(err instanceof LinkConflict)) throw err;
    // Another request refreshed first. Its token is the live one now.
    const again = await readLink(owner);
    const theirs = again && open(again.sealed, owner);
    return theirs && fresh(theirs, now) ? toSession(theirs) : null;
  }
}

/**
 * Procore refused the access token mid-request (401). Mark the stored one
 * spent, so the next request refreshes instead of reusing it.
 */
export async function forgetAccess(owner: string): Promise<void> {
  if (!linkStoreConfigured()) return;
  const row = await readLink(owner);
  const link = row && open(row.sealed, owner);
  if (!row || !link) return;
  await writeLink(owner, seal({ ...link, expiresAt: 0 }), row.etag).catch(() => {});
}

export async function unlink(owner: string): Promise<void> {
  if (linkStoreConfigured()) await deleteLink(owner);
}
