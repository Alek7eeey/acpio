/**
 * Static harness adapter registry — the only place the core knows concrete
 * harnesses. Adding a third-party harness = implement {@link HarnessAdapter}
 * (in a package depending on `@acprocess/shared`) and register it here.
 */
import { cursorAdapter } from "@acprocess/adapter-cursor";
import { ompAdapter } from "@acprocess/adapter-omp";
import type { AdapterRegistry, AppSettings, HarnessAdapter } from "@acprocess/shared";

const ALL: HarnessAdapter[] = [cursorAdapter, ompAdapter];
const BY_ID = new Map<string, HarnessAdapter>(ALL.map((a) => [a.id, a]));

export const adapters: AdapterRegistry = {
  get(id: string): HarnessAdapter | undefined {
    return BY_ID.get(id);
  },
  list(): HarnessAdapter[] {
    return [...ALL];
  },
  ids(): string[] {
    return ALL.map((a) => a.id);
  },
};

export function getAdapter(provider: string): HarnessAdapter {
  const adapter = BY_ID.get(provider);
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
