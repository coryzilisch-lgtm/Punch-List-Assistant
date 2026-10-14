import { createHmac } from 'node:crypto';

/**
 * Where a super's Procore link is kept between sessions: one row per Entra
 * user in an Azure Storage table, so connecting Procore is a one-time thing.
 *
 * Asked for by Cory, 2026-10-14 ("permanently link their procore account so
 * they don't have to sign in every time"). It reverses the first OAuth build's
 * "no refresh token at rest" choice, so the row holds as little as it can:
 * one value, sealed with PROCORE_SESSION_KEY (AES-256-GCM, the same seal as
 * the session cookie). The storage key alone opens nothing; the session key
 * alone reaches nothing.
 *
 * Talks to the Table service's REST API directly rather than through the Azure
 * SDK: SWA caps a deployment at ~15,000 files, and one SDK has already broken a
 * sibling app's deploys. This needs a signature, three verbs and an ETag.
 *
 * Off unless PROCORE_LINK_STORE (a storage account connection string) is set.
 * Without it the app behaves exactly as before: a ~2 hour session per browser.
 */

const TABLE = 'procorelinks';
const PARTITION = 'u';
const API_VERSION = '2019-02-02';

interface Account {
  name: string;
  key: Buffer;
  base: string;
}

function account(): Account | null {
  const raw = (process.env.PROCORE_LINK_STORE || '').trim();
  if (!raw) return null;
  const parts = Object.fromEntries(
    raw
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
  );
  const name = parts.AccountName;
  const key = parts.AccountKey;
  if (!name || !key) return null;
  const base = (parts.TableEndpoint || `https://${name}.table.${parts.EndpointSuffix || 'core.windows.net'}`).replace(/\/$/, '');
  return { name, key: Buffer.from(key, 'base64'), base };
}

export function linkStoreConfigured(): boolean {
  return account() !== null;
}

/** A setting that is present but unusable, by name only, for the setup card. */
export function linkStoreProblem(): string | null {
  const raw = (process.env.PROCORE_LINK_STORE || '').trim();
  if (!raw) return null;
  return account() ? null : 'PROCORE_LINK_STORE must be the storage account connection string (AccountName=…;AccountKey=…)';
}

export class LinkConflict extends Error {
  constructor() {
    super('The stored Procore link changed since it was read.');
    this.name = 'LinkConflict';
  }
}

/** One table request, signed with SharedKeyLite. */
async function call(method: string, resource: string, opts: { body?: unknown; ifMatch?: string } = {}): Promise<Response> {
  const acct = account();
  if (!acct) throw new Error('PROCORE_LINK_STORE is not configured');
  const date = new Date().toUTCString();
  const signature = createHmac('sha256', acct.key).update(`${date}\n/${acct.name}/${resource}`, 'utf8').digest('base64');
  const headers: Record<string, string> = {
    'x-ms-date': date,
    'x-ms-version': API_VERSION,
    Authorization: `SharedKeyLite ${acct.name}:${signature}`,
    Accept: 'application/json;odata=nometadata',
    DataServiceVersion: '3.0;NetFx',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  return fetch(`${acct.base}/${resource}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function entity(owner: string): string {
  // OData string literal: quotes doubled. Entra object ids are GUIDs, but the
  // key comes from a header, so it is escaped anyway.
  const key = owner.replace(/'/g, "''");
  return `${TABLE}(PartitionKey='${PARTITION}',RowKey='${encodeURIComponent(key)}')`;
}

async function fail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => '');
  throw new Error(`Procore link store ${what} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
}

/** The sealed link for this Entra user, with its ETag for a conditional write. */
export async function readLink(owner: string): Promise<{ sealed: string; etag: string } | null> {
  const res = await call('GET', entity(owner));
  if (res.status === 404) return null; // no row, or no table yet: not linked
  if (!res.ok) return fail(res, 'read');
  const row = (await res.json()) as { link?: string };
  const etag = res.headers.get('ETag') || '*';
  return typeof row.link === 'string' ? { sealed: row.link, etag } : null;
}

/**
 * Store the sealed link. With `etag`, only if the row is unchanged since it was
 * read (a refresh racing another tab's refresh loses cleanly, as LinkConflict).
 * Without it, insert or replace: a fresh connect always wins.
 */
export async function writeLink(owner: string, sealed: string, etag?: string): Promise<void> {
  const body = { PartitionKey: PARTITION, RowKey: owner, link: sealed };
  let res = await call('PUT', entity(owner), { body, ifMatch: etag });
  if (res.status === 404 && !etag) {
    // First link ever: the table does not exist yet.
    const made = await call('POST', 'Tables', { body: { TableName: TABLE } });
    if (!made.ok && made.status !== 409) return fail(made, 'create table');
    res = await call('PUT', entity(owner), { body });
  }
  if (res.status === 412 || (etag && res.status === 404)) throw new LinkConflict();
  if (!res.ok) return fail(res, 'write');
}

export async function deleteLink(owner: string): Promise<void> {
  const res = await call('DELETE', entity(owner), { ifMatch: '*' });
  if (res.status === 404) return;
  if (!res.ok) return fail(res, 'delete');
}
