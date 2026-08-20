import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import * as z from 'zod/v4';

/**
 * Where Claude is called from.
 *
 * Production is **Claude on Microsoft Foundry** — the model runs against
 * Buffalo's own Azure AI Foundry resource and bills through the Microsoft
 * Marketplace, so this app never depends on a personal Anthropic key. That was
 * a deliberate requirement: the Herd Intranet moved Roman off a personal key for
 * the same reason, and a second app quietly reintroducing one would undo it.
 *
 * The direct Anthropic API is kept as a fallback purely for local development,
 * where a developer key is the practical way to try a document without
 * deploying. Deployed, Foundry wins whenever it is configured.
 *
 * Both clients expose the SAME `messages` resource — the Foundry SDK types it as
 * `Omit<Resources.Messages, 'batches'>` — so `messages.parse()`, structured
 * outputs, vision and adaptive thinking all work identically. Nothing in
 * `extract.ts` needs to know which one it got.
 */

export type Provider = 'foundry' | 'anthropic';

/** The slice of the client surface this app actually uses. */
export type MessagesApi = Pick<Anthropic['messages'], 'parse'>;

export interface ModelConfig {
  provider: Provider;
  model: string;
  /** Human-readable description of where calls go, for the probe and /api/health. */
  endpointLabel: string;
}

/**
 * Foundry is selected by the presence of a resource (or an explicit base URL),
 * not by a mode flag. One less setting to get wrong, and it means adding the
 * Foundry settings is all it takes to move off the direct API.
 */
export function resolveProvider(): Provider | null {
  const override = process.env.PUNCH_AI_PROVIDER as Provider | undefined;
  if (override === 'foundry' || override === 'anthropic') return override;

  if (process.env.ANTHROPIC_FOUNDRY_RESOURCE || process.env.ANTHROPIC_FOUNDRY_BASE_URL) {
    return 'foundry';
  }
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export function modelId(): string {
  // No default that pretends to know the Foundry catalog. Foundry model ids come
  // from what has actually been deployed in the resource, and guessing one
  // produces a 404 at the worst possible moment — after a super has reviewed
  // sixty items. PUNCH_EXTRACT_MODEL is required for Foundry; the probe says so
  // in plain language when it is missing.
  const configured = process.env.PUNCH_EXTRACT_MODEL;
  if (configured) return configured;
  return resolveProvider() === 'foundry' ? '' : 'claude-opus-5';
}

export function modelConfig(): ModelConfig | null {
  const provider = resolveProvider();
  if (!provider) return null;

  if (provider === 'foundry') {
    const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    const baseURL = process.env.ANTHROPIC_FOUNDRY_BASE_URL;
    return {
      provider,
      model: modelId(),
      endpointLabel: baseURL || `https://${resource}.services.ai.azure.com/anthropic/`,
    };
  }

  return { provider, model: modelId(), endpointLabel: 'https://api.anthropic.com' };
}

let cached: { provider: Provider; api: MessagesApi } | null = null;

export function messagesApi(): MessagesApi {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'No AI provider is configured. Set ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY ' +
        '(Claude on Microsoft Foundry), or ANTHROPIC_API_KEY for the direct API.',
    );
  }
  if (cached?.provider === provider) return cached.api;

  if (provider === 'foundry') {
    const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_FOUNDRY_API_KEY is not set. It is the key from the Azure AI Foundry ' +
          "resource's Keys and Endpoint page.",
      );
    }
    if (!modelId()) {
      throw new Error(
        'PUNCH_EXTRACT_MODEL is not set. On Foundry it must name a Claude model deployed in ' +
          'the resource — there is no safe default, because the id depends on what was deployed.',
      );
    }
    // `resource` and `baseURL` are mutually exclusive in the SDK, so pass
    // exactly one: the explicit base URL when given, otherwise the resource name.
    const client = process.env.ANTHROPIC_FOUNDRY_BASE_URL
      ? new AnthropicFoundry({ apiKey, baseURL: process.env.ANTHROPIC_FOUNDRY_BASE_URL })
      : new AnthropicFoundry({ apiKey, resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE });

    cached = { provider, api: client.messages };
    return cached.api;
  }

  cached = { provider, api: new Anthropic().messages };
  return cached.api;
}

export function aiConfigured(): boolean {
  const cfg = modelConfig();
  if (!cfg) return false;
  if (cfg.provider === 'foundry') {
    return Boolean(process.env.ANTHROPIC_FOUNDRY_API_KEY && cfg.model);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Make the cheapest possible real call, to prove the endpoint, the key and the
 * model id all line up.
 *
 * This exists because the three ways this goes wrong on Foundry are
 * indistinguishable from the outside — a wrong resource name, a key from the
 * wrong resource, and a model id that was never deployed all just fail. Finding
 * out during setup costs a fraction of a cent; finding out after a
 * superintendent has reviewed sixty items costs their afternoon.
 */
export async function checkModelAccess(): Promise<{ ok: boolean; detail: string }> {
  const cfg = modelConfig();
  if (!cfg) {
    return {
      ok: false,
      detail:
        'No AI provider configured. Set ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY ' +
        '+ PUNCH_EXTRACT_MODEL in the app settings.',
    };
  }
  if (cfg.provider === 'foundry' && !cfg.model) {
    return {
      ok: false,
      detail:
        'PUNCH_EXTRACT_MODEL is not set. On Foundry it must name a Claude model deployed in ' +
        `${cfg.endpointLabel} — check the deployment name in the Azure AI Foundry portal.`,
    };
  }

  const where = cfg.provider === 'foundry' ? 'Claude on Microsoft Foundry' : 'Anthropic API';

  try {
    // Exercise the SAME request shape extraction uses — structured output via
    // output_config plus adaptive thinking — not just a bare "does it answer".
    // Both are GA on the first-party API but only beta on Foundry, so a
    // deployment can answer a plain message and still reject the request this
    // app actually sends. That difference has to surface here, during setup,
    // rather than on page one of a real punch list.
    const response = await messagesApi().parse({
      model: cfg.model,
      max_tokens: 64,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'Reply with ok set to true.' }],
      output_config: {
        format: zodOutputFormat(z.object({ ok: z.boolean() })),
        effort: 'low',
      },
    });

    if (!response.parsed_output) {
      return {
        ok: false,
        detail:
          `${where} answered, but returned no structured output. The endpoint works; ` +
          'structured outputs (output_config) appear unsupported on this deployment. ' +
          `Model ${cfg.model} via ${cfg.endpointLabel}.`,
      };
    }

    return {
      ok: true,
      detail: `Reachable, with structured output and thinking — ${where}, model ${cfg.model}, via ${cfg.endpointLabel}`,
    };
  } catch (err) {
    return { ok: false, detail: `${describeAiError(err)} (${cfg.endpointLabel}, model ${cfg.model})` };
  }
}

/** Turn an SDK error into something an admin can act on. */
export function describeAiError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403) {
    return `Rejected (HTTP ${status}) — the API key is wrong, or it belongs to a different Azure resource than the one configured.`;
  }
  if (status === 404) {
    return `Not found (HTTP 404) — usually the model id is not deployed in this resource, or the resource name is wrong.`;
  }
  if (status === 400 && /output_config|thinking|effort|beta|not supported|unsupported/i.test(message)) {
    return `Rejected (HTTP 400) — the deployment refused part of the request: ${message}. On Foundry, structured outputs and adaptive thinking are beta; if they are unavailable on this deployment the extractor needs a tool-based schema instead.`;
  }
  if (status === 429) {
    return 'Rate limited (HTTP 429) — the deployment is at its quota. Raise the tokens-per-minute quota on the deployment.';
  }
  return message;
}
