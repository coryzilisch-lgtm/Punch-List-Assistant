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

/**
 * The database holding the Vendor Compliance tool's roster, when it is not the
 * one the project mirror lives in.
 *
 * Cory's vendor list is kept by a different app, and two Fabric SQL databases in
 * the same workspace are reached with the same service principal and the same
 * server — only the catalog name differs. So this is one optional setting rather
 * than a second copy of all five, and leaving it unset means "same database",
 * which is the common case.
 */
function vendorDatabase(): string {
  return process.env.PUNCH_VENDOR_SQL_DATABASE || (process.env.FABRIC_SQL_DATABASE as string);
}

const config = (database: string, server?: string): sql.config => ({
  server: server || (process.env.FABRIC_SQL_SERVER as string),
  database,
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

/** One pool per database — the vendor roster may live in a different catalog. */
const pools = new Map<string, sql.ConnectionPool>();

async function getPool(database: string, server?: string): Promise<sql.ConnectionPool> {
  const key = `${server ?? ''}/${database}`;
  const existing = pools.get(key);
  if (existing?.connected) return existing;
  const created = await new sql.ConnectionPool(config(database, server)).connect();
  created.on('error', () => {
    // A dead pooled socket must not be reused. Both sibling apps learned this
    // as "Connection lost - socket hang up" after an idle period.
    pools.delete(key);
  });
  pools.set(key, created);
  return created;
}

async function query<T>(text: string, database?: string, server?: string): Promise<T[]> {
  const db = database || (process.env.FABRIC_SQL_DATABASE as string);
  const key = `${server ?? ''}/${db}`;
  try {
    const result = await (await getPool(db, server)).request().query(text);
    return result.recordset as T[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/socket hang up|Connection lost|ECONNCLOSED|ECONNRESET|ETIMEOUT|ESOCKET/i.test(message)) {
      // One retry on a connection-shaped failure: the pool can hold a socket the
      // server has already dropped, and the first use after an idle spell fails.
      pools.delete(key);
      const result = await (await getPool(db, server)).request().query(text);
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

/**
 * Look for a vendor list in whatever Fabric database this app is pointed at.
 *
 * The Vendor Compliance tool keeps one, and the subs on a job are exactly the
 * companies a punch item gets assigned to — but a vendor list is only useful
 * here if it carries **Procore's** vendor id. Procore will not accept the
 * compliance tool's own key, and an id that looks plausible and belongs to a
 * different system is worse than no list at all: it would assign items to the
 * wrong company silently.
 *
 * So this reports what exists rather than assuming a schema — which table, which
 * columns, which of those columns look like an id, and **what values they
 * actually hold**. The samples are the point: a Procore vendor id is a plain
 * integer in the same range as the ones already on the punch items, while the
 * compliance tool's own key is a GUID, a normalized name, or a small sequence.
 * That difference is visible in three sample rows and invisible in a column
 * name, and this integration has been burned by plausible-looking names before.
 *
 * Nothing here is wired into the picker. Reading a column and believing it is
 * two different things, and only a person who knows how Vendor Compliance keys
 * its rows can do the second.
 */
export async function findVendorTables(): Promise<{
  database: string;
  tables: Array<{
    table: string;
    columns: string[];
    procoreIdColumns: string[];
    idCandidates: Array<{ column: string; type: string; samples: unknown[]; looksLikeProcoreId: boolean }>;
    rows: number | null;
  }>;
}> {
  const db = vendorDatabase();
  const server = process.env.PUNCH_VENDOR_SQL_SERVER || undefined;
  const ask = <T>(text: string) => query<T>(text, db, server);

  const rows = await ask<{
    TABLE_SCHEMA: string;
    TABLE_NAME: string;
    COLUMN_NAME: string;
    DATA_TYPE: string;
  }>(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE TABLE_NAME LIKE '%vendor%' OR TABLE_NAME LIKE '%subcontractor%' ` +
      `OR TABLE_NAME LIKE '%compan%'`,
  );

  const byTable = new Map<string, Array<{ name: string; type: string }>>();
  for (const r of rows) {
    const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`;
    byTable.set(key, [...(byTable.get(key) ?? []), { name: r.COLUMN_NAME, type: r.DATA_TYPE }]);
  }

  const out = [];
  for (const [table, columns] of byTable) {
    const names = columns.map((c) => c.name);
    const procoreIdColumns = names.filter((c) => /procore/i.test(c) && /id$/i.test(c));

    // Cast a wider net than the name filter: a Procore id can sit in a column
    // called plainly `id`, and the whole point is to look rather than to trust
    // the naming.
    const idish = columns.filter((c) => /(^id$|_id$|id$|number|key)/i.test(c.name)).slice(0, 8);

    let count: number | null = null;
    try {
      const [row] = await ask<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      count = row?.n ?? null;
    } catch {
      // A table we cannot count is still worth reporting by name and shape.
    }

    const idCandidates = [];
    for (const col of idish) {
      let samples: unknown[] = [];
      try {
        const sampled = await ask<{ v: unknown }>(
          `SELECT TOP 3 [${col.name}] AS v FROM ${table} WHERE [${col.name}] IS NOT NULL`,
        );
        samples = sampled.map((r) => r.v);
      } catch {
        // A column we cannot read tells us nothing, which is itself reportable.
      }
      idCandidates.push({
        column: col.name,
        type: col.type,
        samples,
        looksLikeProcoreId: samples.length > 0 && samples.every(isProcoreIdShaped),
      });
    }

    out.push({ table, columns: names.sort(), procoreIdColumns, idCandidates, rows: count });
  }
  return { database: db, tables: out.sort((a, b) => a.table.localeCompare(b.table)) };
}

/**
 * Does this value have the shape of a Procore id?
 *
 * Procore ids are positive integers, and the ones in this tenant run to seven
 * and eight digits (project 603781, punch item 275). This is a shape test and
 * nothing more — it rules a column OUT, it never rules one IN. A five-digit
 * sequence from another system passes this and is still the wrong number.
 */
export function isProcoreIdShaped(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  return /^\d{3,12}$/.test(value.trim());
}
