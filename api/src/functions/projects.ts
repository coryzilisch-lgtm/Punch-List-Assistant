import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { errorResponse, guarded, json } from '../lib/http';
import {
  getProjectPunchConfig,
  listProjects,
  ProcoreError,
  procoreConfigured,
  ProcoreProject,
} from '../lib/procore';
import { fabricConfigured, fabricSyncedAt, listProjectsFromFabric } from '../lib/fabric';

/**
 * GET /api/projects            — projects the super can import into.
 * GET /api/projects/{id}/config — that project's punch list configuration
 *                                 (types, locations, trades, vendors, users),
 *                                 so the review screen offers real Procore
 *                                 values instead of free text.
 *
 * Reads go straight to the Procore API rather than through the Fabric mirror the
 * Safety Dashboard uses. The mirror is a nightly snapshot, which is right for
 * reporting and wrong here: a punch walk often happens on a project that was set
 * up that morning, and the ids we send back must be the ones Procore holds right
 * now, not the ones it held at 2am.
 */

// The project list barely changes and is expensive to fetch, so it is cached
// harder than the per-project config.
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROJECTS_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, ttl = CACHE_TTL_MS): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > ttl) return null;
  return hit.value as T;
}

function putCache(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
}

function stageName(p: ProcoreProject): string | null {
  const s = p.project_stage;
  if (!s) return null;
  return typeof s === 'string' ? s : (s.name ?? null);
}

/**
 * The project list, from the Fabric mirror when it is available.
 *
 * Procore is the fallback, not the default. Listing a real company's projects
 * from the API is serial and paginated, and it shares a ~3,600/hour quota with
 * the Safety Dashboard's ingest — inside a Function Azure kills at 45 seconds.
 * That is what "Backend call failure" was.
 *
 * The mirror is a nightly snapshot, so a project created this morning will not
 * be in it. That is the whole reason Procore is kept: if the mirror is missing
 * or fails, the slower path still answers, and the response says which source
 * produced the list and how fresh it is so a stale list is never mistaken for
 * the truth.
 */
async function loadProjectList(context: InvocationContext) {
  if (fabricConfigured()) {
    try {
      const [projects, syncedAt] = await Promise.all([listProjectsFromFabric(), fabricSyncedAt()]);
      if (projects.length) {
        return { source: 'fabric' as const, syncedAt, truncated: false, projects };
      }
      context.warn('fabric project mirror returned no rows; falling back to Procore');
    } catch (err) {
      context.error(`fabric project mirror failed, falling back to Procore: ${String(err)}`);
    }
  }

  const { projects, truncated } = await listProjects();
  return {
    source: 'procore' as const,
    syncedAt: null,
    truncated,
    projects: projects
      .map((p) => ({
        id: p.id,
        name: p.name,
        number: p.project_number ?? null,
        stage: stageName(p),
        active: p.active !== false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function projectsHandler(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!procoreConfigured()) {
    return errorResponse(
      503,
      'Procore is not configured on this deployment. PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET and PROCORE_COMPANY_ID must be set in the app settings.',
    );
  }

  const projectId = request.params.id ? Number(request.params.id) : null;

  try {
    if (projectId) {
      const key = `config:${projectId}`;
      const hit = cached(key);
      if (hit) return json(hit);
      const config = await getProjectPunchConfig(projectId);
      putCache(key, config);
      return json(config);
    }

    const hit = cached<unknown>('projects', PROJECTS_TTL_MS);
    if (hit) return json(hit);

    const payload = await loadProjectList(context);
    putCache('projects', payload);
    return json(payload);
  } catch (err) {
    if (err instanceof ProcoreError) {
      context.error(`projects failed: ${err.message}`);
      return errorResponse(
        err.status === 403 ? 403 : 502,
        err.status === 403
          ? 'Procore refused the request. The service account may not have access to this project or tool.'
          : `Procore returned HTTP ${err.status}.`,
        { procore: err.fieldErrors() },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    context.error(`projects failed: ${message}`);
    return errorResponse(502, message);
  }
}

app.http('projects', {
  methods: ['GET'],
  authLevel: 'anonymous', // the SWA route config requires an authenticated user
  route: 'projects',
  handler: guarded('projects', projectsHandler),
});

app.http('projectConfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'projects/{id}/config',
  handler: guarded('projects', projectsHandler),
});
