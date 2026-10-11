/**
 * Harness registry — built-in adapters plus user-defined ACP agents. Custom
 * agents are data (Settings → Connect → Custom agents): the core only ever sees
 * a {@link HarnessAdapter}, never a vendor.
 */
import { builtinAdapter, builtinPresetAdapter } from "@acpio/adapter-builtin";
import { cursorAdapter } from "@acpio/adapter-cursor";
import { ompAdapter } from "@acpio/adapter-omp";
import { opencodeAdapter } from "@acpio/adapter-opencode";
import {
  builtinPresetProviderId,
  customAgentAdapter,
  SHELL_SESSION_PROVIDER,
} from "@acpio/shared";
import type {
  AdapterRegistry,
  AppSettings,
  BuiltinPresetSpec,
  CustomAgentSpec,
  HarnessAdapter,
} from "@acpio/shared";

const BUILT_IN: HarnessAdapter[] = [cursorAdapter, ompAdapter, opencodeAdapter, builtinAdapter];

/** Ids a user-defined agent may not take: built-ins and the shell session. */
export const RESERVED_AGENT_IDS: readonly string[] = [
  ...BUILT_IN.map((a) => a.id),
  SHELL_SESSION_PROVIDER,
];

let all: HarnessAdapter[] = [...BUILT_IN];
let byId = new Map<string, HarnessAdapter>(all.map((a) => [a.id, a]));

/** Provider ids the presets of the built-in agent take, in registration order. */
export function presetProviderIds(presets: readonly BuiltinPresetSpec[]): string[] {
  return presets.map((p) => builtinPresetProviderId(p.id));
}

/**
 * Replace the user-defined half of the registry: the built-in agent's presets
 * (Settings → Built-in agent) plus user-defined ACP agents (Settings →
 * Connect). Called with the merged settings (and again on every read), so a
 * settings edit cannot leave a stale agent spawnable.
 */
export function setCustomAdapters(
  specs: readonly CustomAgentSpec[],
  presets: readonly BuiltinPresetSpec[] = [],
): void {
  const presetAdapters = presets.map(builtinPresetAdapter);
  const custom = specs.map(customAgentAdapter);
  all = [...BUILT_IN, ...presetAdapters, ...custom];
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

/**
 * Harness an adapter belongs to: an adapter that derives from another one (a
 * preset of the built-in agent) names it in `family`. Unknown ids report
 * themselves, so a caller can tell "not registered" from "another harness".
 */
export function adapterFamily(provider: string): string {
  const adapter = byId.get(provider);
  return adapter?.family ?? adapter?.id ?? provider;
}

/** True for the built-in agent and every preset of it: one in-process harness. */
export function isBuiltinFamily(provider: string): boolean {
  return adapterFamily(provider) === builtinAdapter.id;
}

/**
 * Settings an adapter actually runs with — a preset's own overlay, or the
 * settings themselves for every other harness.
 */
export function adapterSettings(provider: string, settings: AppSettings): AppSettings {
  const adapter = byId.get(provider);
  return adapter?.settingsFor ? adapter.settingsFor(settings) : settings;
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
