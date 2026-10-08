import {
  BUILTIN_FALLBACK_CONTEXT_WINDOW,
  builtinModelValue,
  healBuiltinProviders,
  modelForProvider,
  parseBuiltinModelValue,
  type AppSettings,
  type BuiltinModelConfig,
  type BuiltinProviderConfig,
} from "@acpio/shared";

/** One provider's endpoint, ready for `createOpenAICompatible`. */
export interface BuiltinEndpoint {
  /** Base URL of an OpenAI-compatible `/chat/completions` endpoint. */
  url: string;
  apiKey: string;
}

/** A configured model together with the provider that serves it. */
export interface BuiltinModelSelection {
  /** Composite value as offered in pickers: `<provider id>::<model id>`. */
  value: string;
  /** Label for pickers — qualified with the provider name when there are several. */
  name: string;
  provider: BuiltinProviderConfig;
  /** Wire id sent to the endpoint. */
  modelId: string;
  contextWindow: number;
}

/** Provider rows, healed on read (settings may predate the current shape). */
export function builtinProviders(settings: AppSettings): BuiltinProviderConfig[] {
  return healBuiltinProviders(settings.builtinProviders);
}

/** True when at least one provider points at an endpoint — the agent can boot. */
export function hasBuiltinEndpoint(settings: AppSettings): boolean {
  return builtinProviders(settings).some((p) => p.url);
}

/** Every configured selection (switched-off rows included) — healing must not
 *  strand a chat pinned to a model the user later turned off. */
function configuredSelections(settings: AppSettings): BuiltinModelSelection[] {
  const providers = builtinProviders(settings);
  const qualify = providers.length > 1;
  const out: BuiltinModelSelection[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      out.push({
        value: builtinModelValue(provider.id, model.id),
        name: qualify ? `${model.label} (${provider.name})` : model.label,
        provider,
        modelId: model.id,
        contextWindow: model.contextWindow,
      });
    }
  }
  return out;
}

/** Models the agent offers in its picker: switched-off rows are hidden. */
export function builtinModelOptions(settings: AppSettings): BuiltinModelSelection[] {
  const disabled = new Set(
    builtinProviders(settings).flatMap((p) =>
      p.models.filter((m) => m.enabled === false).map((m) => builtinModelValue(p.id, m.id)),
    ),
  );
  return configuredSelections(settings).filter((s) => !disabled.has(s.value));
}

/**
 * Resolve a picked/stored model value to its provider. A bare id written
 * before providers existed resolves to the first provider offering it;
 * unknown values come back null.
 */
export function resolveBuiltinModel(
  settings: AppSettings,
  value: string,
): BuiltinModelSelection | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const options = configuredSelections(settings);
  const parsed = parseBuiltinModelValue(trimmed, builtinProviders(settings));
  if (parsed.providerId) {
    return options.find((s) => s.value === trimmed) ?? null;
  }
  return options.find((s) => s.modelId === parsed.modelId) ?? null;
}

/** Context window of the value the session is on (fallback when unknown). */
export function contextWindowOf(settings: AppSettings, value: string): number {
  return resolveBuiltinModel(settings, value)?.contextWindow ?? BUILTIN_FALLBACK_CONTEXT_WINDOW;
}

/**
 * Model the subagent children run on: the configured `builtinSubagents.model`
 * when it resolves, else the session's own selection. An empty setting is the
 * default — children inherit the current model — and never falls back.
 * `fellBack` marks a configured value that no longer exists, so the caller can
 * say so instead of silently running children on a model the user un-picked.
 */
export function subagentModelChoice(
  settings: AppSettings,
  parent: BuiltinModelSelection,
): { selection: BuiltinModelSelection; fellBack: boolean } {
  const configured = settings.builtinSubagents?.model?.trim();
  if (!configured) return { selection: parent, fellBack: false };
  const resolved = resolveBuiltinModel(settings, configured);
  return resolved ? { selection: resolved, fellBack: false } : { selection: parent, fellBack: true };
}

/** Model the agent starts with: stored default → first offered model. The
 *  resolved value is returned so a bare legacy default comes back composite. */
export function initialModelId(settings: AppSettings): string {
  const stored = (modelForProvider(settings, "builtin") ?? "").trim();
  const resolved = stored ? resolveBuiltinModel(settings, stored) : null;
  return resolved?.value ?? builtinModelOptions(settings)[0]?.value ?? "";
}
