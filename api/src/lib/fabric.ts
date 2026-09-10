import sql from 'mssql';

/**
 * Reading the project list from the Fabric SQL mirror instead of Procore.
 *
 * The Procore path could not survive its own success: listing a real company's
 * projects is serial, paginated, and shares a ~3,600/hour quota with the Safety
 * Dashboard's nightly ingest — all inside a Function that Azure kills at 45
 * seconds. A single 429 was enough to take it down, and the failure surfaced as
 * "Backend call failure" with nothing to diagnose.
 *
 * The mirror answers in milliseconds and costs Procore nothing. It is a nightly
 * snapshot, which is the one real trade-off: a project created this morning is
 * not in it yet. That is why Procore stays as the fallback rather than being
 * removed — see `listProjectsPreferringFabric`.
 *
 * Connection notes carried over from the two apps that already do this:
 *  - The server MUST be a Fabric **SQL Database** (`*.database.fabric.microsoft.com`).
 *    The Lakehouse/Warehouse endpoint (`*.datawarehouse.fabric.microsoft.com`)
 *    cannot be reached by tedious at all — no auth mode, no TLS setting fixes it.
 *  - The service principal needs BOTH workspace Contributor and Read-all-data on
 *    the database item, granted in the Fabric portal. T-SQL `CREATE USER` was
 *    locked down at GA and is not an alternative.
 */

export interface FabricProject {
  id: number;
  name: string;
  number: string | null;
  stage: string | null;
  active: boolean;
}

export function fabricConfigured(): boolean {
  return Boolean(
    process.env.FABRIC_SQL_SERVER &&
      process.env.FABRIC_SQL_DATABASE &&
      process.env.AZURE_CLIENT_ID &&
      process.env.AZURE_CLIENT_SECRET &&
      process.env.AZURE_TENANT_ID,
  );
}

const config = (): sql.config => ({
  server: process.env.FABRIC_SQL_SERVER as string,
  database: process.env.FABRIC_SQL_DATABASE as string,
  authentication: {
    type: 'azure-active-directory-service-principal-secret',
    options: {
      clientId: process.env.AZURE_CLIENT_ID as string,
      clientSecret: process.env.AZURE_CLIENT_SECRET as string,
      tenantId: process.env.AZURE_TENANT_ID as string,
    },
  },
  options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
  pool: { max: 4, min: 0, idleTimeoutMillis: 5 * 60_000 },
  connectionTimeout: 15_000,
  requestTimeout: 20_000,
});

let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;
  pool = await new sql.ConnectionPool(config()).connect();
  pool.on('error', () => {
    // A dead pooled socket must not be reused. Both sibling apps learned this
    // as "Connection lost - socket hang up" after an idle period.
    pool = null;
  });
  return pool;
}

async function query<T>(text: string): Promise<T[]> {
  try {
    const result = await (await getPool()).request().query(text);
    return result.recordset as T[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/socket hang up|Connection lost|ECONNCLOSED|ECONNRESET|ETIMEOUT|ESOCKET/i.test(message)) {
      // One retry on a connection-shaped failure: the pool can hold a socket the
      // server has already dropped, and the first use after an idle spell fails.
      pool = null;
      const result = await (await getPool()).request().query(text);
      return result.recordset as T[];
    }
    throw err;
  }
}

/**
 * Which table and columns hold the projects.
 *
 * The two mirrors in this tenant do not agree on names — herd-intranet has
 * `silver_procore_projects_enriched(procore_id, project_stage, active)` while
 * Safety-Dash has `projects(id, stage, is_active)` — so the columns are
 * discovered rather than assumed. Naming a column that is not there is a SQL
 * parse error that fails the whole query, and the mirror's shape follows
 * whatever pipeline ran last.
 */
interface TableShape {
  table: string;
  idCol: string;
  nameCol: string;
  numberCol: string | null;
  stageCol: string | null;
  activeCol: string | null;
}

let shape: TableShape | null | undefined;

const CANDIDATE_TABLES = [
  'dbo.silver_procore_projects_enriched',
  'dbo.projects',
  'dbo.silver_procore_project_details_enriched',
];

const pick = (cols: Set<string>, ...names: string[]) => names.find((n) => cols.has(n)) ?? null;

async function resolveShape(): Promise<TableShape | null> {
  if (shape !== undefined) return shape;

  const configured = process.env.PUNCH_PROJECTS_TABLE;
  const tables = configured ? [configured, ...CANDIDATE_TABLES] : CANDIDATE_TABLES;

  const rows = await query<{ TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string }>(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS`,
  );

  const byTable = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`.toLowerCase();
    if (!byTable.has(key)) byTable.set(key, new Set());
    byTable.get(key)!.add(r.COLUMN_NAME.toLowerCase());
  }

  for (const table of tables) {
    const cols = byTable.get(table.toLowerCase());
    if (!cols) continue;
    const idCol = pick(cols, 'procore_id', 'id', 'project_procore_id');
    const nameCol = pick(cols, 'name', 'project_name');
    if (!idCol || !nameCol) continue;
    shape = {
      table,
      idCol,
      nameCol,
      numberCol: pick(cols, 'project_number', 'number'),
      stageCol: pick(cols, 'project_stage', 'stage'),
      activeCol: pick(cols, 'active', 'is_active'),
    };
    return shape;
  }

  shape = null;
  return shape;
}

/** Stages that are never a valid import target, matched case-insensitively. */
const CLOSED_STAGE_PATTERNS = [
  '%lost%',
  '%closed%',
  '%complete%',
  '%warranty%',
  '%bidding%',
  '%pending%',
  '%post construction%',
  '%post-construction%',
];

export async function listProjectsFromFabric(): Promise<FabricProject[]> {
  const s = await resolveShape();
  if (!s) throw new Error('No project table found in the Fabric database');

  const stageSelect = s.stageCol ? `[${s.stageCol}]` : 'CAST(NULL AS NVARCHAR(100))';
  const numberSelect = s.numberCol ? `[${s.numberCol}]` : 'CAST(NULL AS NVARCHAR(100))';
  const activeSelect = s.activeCol ? `[${s.activeCol}]` : 'CAST(1 AS BIT)';

  // Filter negatively: a project whose stage is NULL or unrecognized should
  // still be offered. Dropping unknowns is how the Safety Dashboard lost every
  // inactive job for months.
  const stageFilter = s.stageCol
    ? `AND (${s.stageCol} IS NULL OR (${CLOSED_STAGE_PATTERNS.map(
        (p) => `LOWER([${s.stageCol}]) NOT LIKE '${p}'`,
      ).join(' AND ')}))`
    : '';

  const rows = await query<{
    id: number | string;
    name: string;
    number: string | null;
    stage: string | null;
    active: unknown;
  }>(
    `SELECT [${s.idCol}] AS id, [${s.nameCol}] AS name, ${numberSelect} AS number,
            ${stageSelect} AS stage, ${activeSelect} AS active
       FROM ${s.table}
      WHERE [${s.idCol}] IS NOT NULL AND [${s.nameCol}] IS NOT NULL
      ${stageFilter}`,
  );

  const seen = new Set<number>();
  const out: FabricProject[] = [];
  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(r.name),
      number: r.number != null ? String(r.number) : null,
      stage: r.stage != null ? String(r.stage) : null,
      // The mirror types this as BIT, INT or the strings 'true'/'false'
      // depending on which pipeline created the table.
      active: !/^(0|false)$/i.test(String(r.active ?? 1)),
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Freshness of the mirror, so the picker can say how old the list is. */
export async function fabricSyncedAt(): Promise<string | null> {
  const s = await resolveShape();
  if (!s) return null;
  try {
    const rows = await query<{ synced: Date | null }>(
      `SELECT MAX(_fabric_loaded_at) AS synced FROM ${s.table}`,
    );
    const v = rows[0]?.synced;
    return v ? new Date(v).toISOString() : null;
  } catch {
    // The column only exists on pipeline-created tables; its absence is not an error.
    return null;
  }
}
