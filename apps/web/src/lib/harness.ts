import type { AgentProvider } from "@acprocess/shared";

export type AgentAvailabilityMap = Partial<Record<AgentProvider, boolean | null>>;

const AVAIL_KEY = "acprocess.agentAvailability.v1";

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
  if (provider === "cursor") return "Cursor";
  if (provider === "omp") return "OMP";
  return provider ? String(provider) : "";
}
