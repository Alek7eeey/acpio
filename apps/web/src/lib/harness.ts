import type { AdapterMetaDto, AgentProvider, AppSettings } from "@acpio/shared";
import { healBuiltinProviders, isShellSession, SHELL_SESSION_PROVIDER } from "@acpio/shared";

export type AgentAvailabilityMap = Partial<Record<AgentProvider, boolean | null>>;

const AVAIL_KEY = "acpio.agentAvailability.v1";

export function readStoredAgentAvailability(): AgentAvailabilityMap {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(AVAIL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: AgentAvailabilityMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true || value === false) out[key as AgentProvider] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeStoredAgentAvailability(map: AgentAvailabilityMap) {
  if (typeof sessionStorage === "undefined") return;
  try {
    const serializable: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(map)) {
      if (value === true || value === false) serializable[key] = value;
    }
    sessionStorage.setItem(AVAIL_KEY, JSON.stringify(serializable));
  } catch {
    /* quota / private mode */
  }
}

export function hasStoredAgentAvailability(map?: AgentAvailabilityMap): boolean {
  const source = map ?? readStoredAgentAvailability();
  return Object.values(source).some((value) => value === true || value === false);
}

export function onlineProviders(
  availability: AgentAvailabilityMap,
  ids: AgentProvider[],
): AgentProvider[] {
  return ids.filter((id) => availability[id] === true);
}

export function pickCreateProvider(
  availability: AgentAvailabilityMap,
  ids: AgentProvider[],
  preferred?: AgentProvider | null,
): AgentProvider | null {
  const online = onlineProviders(availability, ids);
  if (!online.length) return null;

  if (preferred && online.includes(preferred)) return preferred;
  return online[0] ?? null;
}

export function harnessShortLabel(provider: AgentProvider | string | null | undefined): string {
  if (isShellSession(provider)) return "Shell";
  if (provider === "cursor") return "Cursor";
  if (provider === "omp") return "OMP";
  if (provider === "opencode") return "OpenCode";
  return provider ? String(provider) : "";
}

/**
 * Harness an adapter belongs to: a preset of the built-in agent reports
 * `"builtin"`, every other adapter is its own harness.
 */
export function adapterFamily(adapter: AdapterMetaDto): AgentProvider {
  return adapter.family ?? adapter.id;
}

/** True for the built-in agent and every preset of it — one in-process harness. */
export function isBuiltinFamilyAdapter(adapter: AdapterMetaDto): boolean {
  return adapterFamily(adapter) === "builtin";
}

/**
 * True when the provider is the built-in agent or a preset of it. A session can
 * outlive the adapter that created it, so an unregistered id counts as its own
 * harness and never as this family.
 */
export function isBuiltinFamilyProvider(
  provider: AgentProvider | string | null | undefined,
  adapters: AdapterMetaDto[],
): boolean {
  if (!provider) return false;
  const adapter = adapters.find((a) => a.id === provider);
  return Boolean(adapter && isBuiltinFamilyAdapter(adapter));
}

/**
 * Why a chat on this harness cannot take a prompt yet, or `null` when it can.
 * The built-in agent — and every preset of it — is the one harness with an
 * in-app precondition: it runs inside the server, so no CLI probe reports it
 * as offline, and a chat on it without a provider endpoint or a model fails on
 * every prompt only after the message was already queued. The web asks this
 * before it takes a prompt so the reason is said up front.
 */
export function harnessNotConfiguredReason(
  provider: AgentProvider | string | null | undefined,
  adapters: AdapterMetaDto[],
  settings: AppSettings,
): "endpoint" | "model" | null {
  if (!isBuiltinFamilyProvider(provider, adapters)) return null;
  const providers = healBuiltinProviders(settings.builtinProviders).filter(
    (p) => p.enabled !== false,
  );
  if (!providers.some((p) => p.url.trim())) return "endpoint";
  return providers.some((p) => p.models.some((m) => m.enabled !== false)) ? null : "model";
}

/**
 * Display label for a provider: the adapter's own label when the registry
 * knows it (user-defined agents included), the built-in short name otherwise
 * (a session can outlive the agent that created it).
 */
export function harnessLabel(
  provider: AgentProvider | string | null | undefined,
  adapters: AdapterMetaDto[],
): string {
  if (!provider) return "";
  return adapters.find((a) => a.id === provider)?.label ?? harnessShortLabel(provider);
}

/**
 * Names of the switched-on harnesses for copy that lists them ("Works with
 * …"). Falls back to the caller's generic phrase when every harness is off.
 */
export function harnessNamesForCopy(adapters: AdapterMetaDto[], fallback: string): string {
  return adapters.length ? adapters.map((a) => a.label).join(", ") : fallback;
}
