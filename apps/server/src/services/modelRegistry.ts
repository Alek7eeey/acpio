/**
 * Model metadata registry (https://models.dev) — context windows for models
 * whose endpoint does not report them in `GET /models`. The payload is keyed
 * by provider: `api` is the OpenAI-compatible base URL, `models[id]` carries
 * `limit.context` in tokens. Every miss (offline, changed URL, unknown model)
 * degrades to "no window", which the caller treats like an unreported one.
 */

/** Public registry the OpenCode tooling itself reads. */
const DEFAULT_REGISTRY_URL = "https://models.dev/api.json";
/** Give up fast — a slow registry must not stall the Settings refresh button. */
const FETCH_TIMEOUT_MS = 15_000;
/** How long one download stays fresh. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed download, do not try again for a while. */
const RETRY_MS = 5 * 60 * 1000;

/** Read-only view of the parsed registry. */
export interface ModelRegistry {
  /** Window of `modelId` on the provider whose base URL matches, if known. */
  contextFor(baseUrl: string, modelId: string): number | undefined;
  /** Window of `modelId` across all providers (most common value wins). */
  contextOf(modelId: string): number | undefined;
  /** Reasoning-effort values of `modelId` on the matching base URL, if stated. */
  effortsFor(baseUrl: string, modelId: string): string[] | undefined;
  /** Reasoning-effort values of `modelId` across all providers. */
  effortsOf(modelId: string): string[] | undefined;
}

interface CacheEntry {
  url: string;
  at: number;
  failed: boolean;
  registry: ModelRegistry | null;
}

let cache: CacheEntry | null = null;

/** Base URLs and ids are compared lowercased, slash-trimmed, `/models`-free. */
function normalizeBase(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\/models$/, "");
}

/** Lookup keys of one model id: itself lowercased plus the part after a slash. */
function lookupKeys(id: string): string[] {
  const lower = id.trim().toLowerCase();
  if (!lower) return [];
  const slash = lower.lastIndexOf("/");
  const suffix = slash >= 0 ? lower.slice(slash + 1) : "";
  return suffix && suffix !== lower ? [lower, suffix] : [lower];
}

/** `limit.context` of one registry model row, when it states a real window. */
function contextOfRow(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined;
  const limit = (row as Record<string, unknown>).limit;
  if (!limit || typeof limit !== "object") return undefined;
  const raw = Number((limit as Record<string, unknown>).context);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
}

/**
 * Effort values of one registry model row: its `reasoning_options` entries of
 * type `effort`. A row that only toggles thinking states no levels, so it
 * yields undefined and the model is treated as having no effort knob.
 */
function effortsOfRow(row: unknown): string[] | undefined {
  if (!row || typeof row !== "object") return undefined;
  const options = (row as Record<string, unknown>).reasoning_options;
  if (!Array.isArray(options)) return undefined;
  const out: string[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const rec = option as Record<string, unknown>;
    if (rec.type !== "effort" || !Array.isArray(rec.values)) continue;
    for (const value of rec.values) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out.length ? out : undefined;
}

/**
 * Parse the registry payload: per-base-URL model windows plus a global id map
 * whose value is the most frequent window (ties go to the smaller one — an
 * over-large window overflows the endpoint, a small one only prunes earlier).
 */
function buildRegistry(body: unknown): ModelRegistry {
  const byBase = new Map<string, Map<string, number>>();
  const votes = new Map<string, Map<number, number>>();
  const effortsByBase = new Map<string, Map<string, string[]>>();
  const effortVotes = new Map<string, Map<string, number>>();
  if (body && typeof body === "object") {
    for (const provider of Object.values(body as Record<string, unknown>)) {
      if (!provider || typeof provider !== "object") continue;
      const p = provider as Record<string, unknown>;
      const models = p.models;
      if (!models || typeof models !== "object") continue;
      const base = normalizeBase(p.api);
      const into = base ? byBase.get(base) ?? byBase.set(base, new Map()).get(base)! : null;
      const intoEfforts = base
        ? effortsByBase.get(base) ?? effortsByBase.set(base, new Map()).get(base)!
        : null;
      for (const [id, row] of Object.entries(models as Record<string, unknown>)) {
        const keys = lookupKeys(id);
        if (!keys.length) continue;
        const context = contextOfRow(row);
        if (context) {
          for (const key of keys) {
            let counts = votes.get(key);
            if (!counts) votes.set(key, (counts = new Map()));
            counts.set(context, (counts.get(context) ?? 0) + 1);
            // First value seen wins inside one base URL — ids rarely collide there.
            if (into && !into.has(key)) into.set(key, context);
          }
        }
        const efforts = effortsOfRow(row);
        if (!efforts) continue;
        const signature = efforts.join("|");
        for (const key of keys) {
          let counts = effortVotes.get(key);
          if (!counts) effortVotes.set(key, (counts = new Map()));
          counts.set(signature, (counts.get(signature) ?? 0) + 1);
          if (intoEfforts && !intoEfforts.has(key)) intoEfforts.set(key, efforts);
        }
      }
    }
  }

  const global = new Map<string, number>();
  for (const [key, counts] of votes) {
    let best = 0;
    let bestCount = -1;
    for (const [context, count] of counts) {
      if (count > bestCount || (count === bestCount && context < best)) {
        best = context;
        bestCount = count;
      }
    }
    global.set(key, best);
  }

  // Same vote for effort lists, ties going to the longer one: a provider that
  // names more levels is the more informative row, and an unknown level on a
  // model that lacks it is the cheaper mistake (the endpoint ignores it).
  const globalEfforts = new Map<string, string[]>();
  for (const [key, counts] of effortVotes) {
    let best: string[] = [];
    let bestCount = -1;
    for (const [signature, count] of counts) {
      const values = signature ? signature.split("|") : [];
      if (count > bestCount || (count === bestCount && values.length > best.length)) {
        best = values;
        bestCount = count;
      }
    }
    if (best.length) globalEfforts.set(key, best);
  }

  return {
    contextFor(baseUrl, modelId) {
      const byId = byBase.get(normalizeBase(baseUrl));
      if (!byId) return undefined;
      for (const key of lookupKeys(modelId)) {
        const value = byId.get(key);
        if (value) return value;
      }
      return undefined;
    },
    contextOf(modelId) {
      for (const key of lookupKeys(modelId)) {
        const value = global.get(key);
        if (value) return value;
      }
      return undefined;
    },
    effortsFor(baseUrl, modelId) {
      const byId = effortsByBase.get(normalizeBase(baseUrl));
      if (!byId) return undefined;
      for (const key of lookupKeys(modelId)) {
        const value = byId.get(key);
        if (value) return value;
      }
      return undefined;
    },
    effortsOf(modelId) {
      for (const key of lookupKeys(modelId)) {
        const value = globalEfforts.get(key);
        if (value) return value;
      }
      return undefined;
    },
  };
}

/**
 * Download and cache the registry. `registryUrl` overrides the default (tests,
 * mirrors); an empty URL — including an empty `ACP_MODELS_REGISTRY_URL` —
 * disables enrichment. Returns null when the registry is unavailable.
 * `force` skips the freshness window: that is the Settings button's job — a
 * click asks for today's effort lists, not for the copy cached at boot.
 */
export async function loadModelRegistry(
  registryUrl?: string,
  opts: { force?: boolean } = {},
): Promise<ModelRegistry | null> {
  const url = (registryUrl ?? process.env.ACP_MODELS_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).trim();
  if (!url) return null;
  const now = Date.now();
  if (
    !opts.force &&
    cache &&
    cache.url === url &&
    now - cache.at < (cache.failed ? RETRY_MS : TTL_MS)
  ) {
    return cache.registry;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    const registry = buildRegistry(await res.json());
    cache = { url, at: Date.now(), failed: false, registry };
    return registry;
  } catch {
    cache = { url, at: Date.now(), failed: true, registry: null };
    return null;
  }
}

/** Drop the cached registry — tests and in-process env changes. */
export function clearModelRegistryCache(): void {
  cache = null;
}
