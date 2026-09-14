/**
 * Harness registry — built-in adapters plus user-defined ACP agents. Custom
 * agents are data (Settings → Connect → Custom agents): the core only ever sees
 * a {@link HarnessAdapter}, never a vendor.
 */
import { cursorAdapter } from "@acpio/adapter-cursor";
import { ompAdapter } from "@acpio/adapter-omp";
import { customAgentAdapter, SHELL_SESSION_PROVIDER } from "@acpio/shared";
import type {
  AdapterRegistry,
  AppSettings,
  CustomAgentSpec,
  HarnessAdapter,
} from "@acpio/shared";

const BUILT_IN: HarnessAdapter[] = [cursorAdapter, ompAdapter];

/** Ids a user-defined agent may not take: built-ins and the shell session. */
export const RESERVED_AGENT_IDS: readonly string[] = [
  ...BUILT_IN.map((a) => a.id),
  SHELL_SESSION_PROVIDER,
];

let all: HarnessAdapter[] = [...BUILT_IN];
let byId = new Map<string, HarnessAdapter>(all.map((a) => [a.id, a]));

/**
 * Replace the user-defined half of the registry. Called with the merged
 * settings (and again on every read), so a settings edit cannot leave a stale
 * agent spawnable.
 */
export function setCustomAdapters(specs: readonly CustomAgentSpec[]): void {
  const custom = specs.map(customAgentAdapter);
  all = [...BUILT_IN, ...custom];
  byId = new Map(all.map((a) => [a.id, a]));
}

export const adapters: AdapterRegistry = {
  get(id: string): HarnessAdapter | undefined {
    return byId.get(id);
  },
  list(): HarnessAdapter[] {
    return [...all];
  },
  ids(): string[] {
    return all.map((a) => a.id);
  },
};

export function getAdapter(provider: string): HarnessAdapter {
  const adapter = byId.get(provider);
  if (!adapter) {
    throw new Error(`Неизвестный агент "${provider}" — не зарегистрирован адаптер`);
  }
  return adapter;
}

/** Read an adapter-declared settings field (dynamic key on a typed object). */
export function adapterSetting(settings: AppSettings, field: string): unknown {
  return (settings as unknown as Record<string, unknown>)[field];
}

/** Command/args for a provider from its adapter config or settings. */
export function adapterCommand(adapter: HarnessAdapter, settings: AppSettings): string {
  const stored = adapterSetting(settings, adapter.commandField);
  return typeof stored === "string" && stored.trim() ? stored.trim() : adapter.defaultCommand;
}

export function adapterArgs(adapter: HarnessAdapter, settings: AppSettings): string[] {
  const stored = adapterSetting(settings, adapter.argsField);
  return Array.isArray(stored) && stored.length ? (stored as string[]) : [...adapter.defaultArgs];
}
