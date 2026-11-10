import {
  type AppSettings,
  type BuiltinModelConfig,
  type BuiltinProviderConfig,
} from "@acpio/shared";
import { nextProviderKey } from "@acpio/adapter-builtin";
import { fetchBuiltinModelCatalog } from "./builtinModelCatalog.js";
import { getSettings, updateSettings } from "./settings.js";

/**
 * A provider worth asking: it has an endpoint and at least one model row with
 * no effort levels yet. Rows that already know their levels are left alone —
 * a model that declares none must not be re-asked on every boot.
 */
function needsEfforts(provider: BuiltinProviderConfig): boolean {
  if (!provider.url?.trim()) return false;
  return provider.models.some((m) => (m.efforts ?? []).length === 0);
}

/** Copy the registry's levels onto the rows that have none, by model id. */
function adoptEfforts(
  provider: BuiltinProviderConfig,
  found: Map<string, string[]>,
): BuiltinProviderConfig {
  const models: BuiltinModelConfig[] = provider.models.map((model) => {
    if ((model.efforts ?? []).length) return model;
    const efforts = found.get(model.id);
    return efforts?.length ? { ...model, efforts } : model;
  });
  return { ...provider, models };
}

/**
 * Fill in the effort levels once, right after an update that introduced them:
 * a picker with nothing but "Default" and "Off" looks broken, and the reader
 * has no reason to know the Settings button is what fixes it.
 *
 * One attempt per install. A successful pass sets the marker so later boots
 * stay offline; a failed one leaves it unset so the next boot tries again.
 * From then on the levels are refreshed only by "Refresh list" in Settings.
 */
export async function seedBuiltinEffortsOnce(): Promise<number> {
  const settings = await getSettings();
  if (settings.builtinEffortsSeeded) return 0;
  const targets = settings.builtinProviders.filter(needsEfforts);
  if (!targets.length) {
    await updateSettings({ builtinEffortsSeeded: true });
    return 0;
  }

  let answered = 0;
  const patched = new Map<string, BuiltinProviderConfig>();
  for (const provider of targets) {
    // The key the pool would use next: a key at 100 % is not asked at all.
    const result = await fetchBuiltinModelCatalog(provider.url, nextProviderKey(provider), {
      headers: provider.headers,
      forceRegistry: true,
    });
    if (!result.ok) continue;
    answered += 1;
    const found = new Map<string, string[]>();
    for (const model of result.models) {
      if (model.efforts?.length) found.set(model.id, model.efforts);
    }
    if (found.size) patched.set(provider.id, adoptEfforts(provider, found));
  }
  if (!answered) return 0;

  // Re-read: the user may have saved the provider form while the fetch was in
  // flight, and their rows must not be replaced by the copy this pass started
  // from.
  const current = await getSettings();
  const builtinProviders = current.builtinProviders.map((p) => patched.get(p.id) ?? p);
  await updateSettings({
    builtinProviders,
    builtinEffortsSeeded: true,
  });
  return patched.size;
}

/** For tests: what one pass would ask for, without touching the network. */
export function providersNeedingEfforts(settings: AppSettings): BuiltinProviderConfig[] {
  return settings.builtinProviders.filter(needsEfforts);
}
