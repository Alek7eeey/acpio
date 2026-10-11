import { builtinPresetProviderId } from "@acpio/shared";
import type {
  AppSettings,
  BuiltinPresetSpec,
  HarnessAdapter,
  InProcessAgentOptions,
} from "@acpio/shared";
import { builtinAdapter } from "./index.js";

/**
 * Fold a preset's knobs onto the settings the built-in agent runs with. A knob
 * the preset does not name is left exactly as the global settings have it — that
 * is what "inherit" means, and why an overlay is applied per session instead of
 * written back to storage.
 */
export function applyBuiltinPreset(settings: AppSettings, preset: BuiltinPresetSpec): AppSettings {
  const next: AppSettings = { ...settings };
  if (preset.thinkingLimit !== undefined) next.builtinThinkingLimit = preset.thinkingLimit;
  if (preset.maxOutputTokens !== undefined) next.builtinMaxOutputTokens = preset.maxOutputTokens;
  if (preset.turnRetryAttempts !== undefined) {
    next.builtinTurnRetryAttempts = preset.turnRetryAttempts;
  }
  if (preset.contextMode) next.builtinContextMode = preset.contextMode;
  if (preset.extraInstructions) next.builtinExtraInstructions = preset.extraInstructions;
  if (preset.allowOutsideCwd !== undefined) {
    next.builtinAllowOutsideCwd = preset.allowOutsideCwd;
  }
  // The preset's model is the ordinary per-harness default of its provider id
  // (`Models → Built-in (Fast)` — one key, not two), and it rides into the slot
  // the built-in agent reads at boot, so a chat on this preset starts on it.
  const model = (settings.defaultModelByProvider?.[builtinPresetProviderId(preset.id)] ?? "").trim();
  if (model) {
    next.defaultModelByProvider = { ...settings.defaultModelByProvider, builtin: model };
  }
  return next;
}

/**
 * The options a preset hands to the built-in transport: its own settings, and a
 * provider that re-applies the overlay, so a knob turned in Settings reaches a
 * chat that is already running. The caller's options are left alone.
 */
export function presetTransportOptions(
  opts: InProcessAgentOptions,
  preset: BuiltinPresetSpec,
): InProcessAgentOptions {
  const withPreset = (settings: AppSettings) => applyBuiltinPreset(settings, preset);
  const provider = opts.settingsProvider;
  return {
    ...opts,
    settings: withPreset(opts.settings),
    ...(provider ? { settingsProvider: async () => withPreset(await provider()) } : {}),
  };
}

/**
 * The built-in agent, narrowed to one preset and registered under its own
 * provider id. The adapter inherits every capability of the built-in agent (an
 * in-process transport, mid-turn steering, the parameterized picker) and only
 * replaces the settings each of those sees: {@link HarnessAdapter.settingsFor}
 * for the core, and a wrapped `settingsProvider` so a knob turned in Settings
 * reaches a chat that is already running.
 */
export function builtinPresetAdapter(preset: BuiltinPresetSpec): HarnessAdapter {
  const withPreset = (settings: AppSettings) => applyBuiltinPreset(settings, preset);
  const { createTransport, unavailableReason, settingsFor: _ignored, ...base } = builtinAdapter;
  return {
    ...base,
    id: builtinPresetProviderId(preset.id),
    label: preset.label,
    descriptionKey: "settings.builtinPresetDesc",
    family: "builtin",
    preset: true,
    settingsFor: withPreset,
    ...(createTransport
      ? { createTransport: (opts) => createTransport(presetTransportOptions(opts, preset)) }
      : {}),
    ...(unavailableReason
      ? { unavailableReason: (settings: AppSettings) => unavailableReason(withPreset(settings)) }
      : {}),
  };
}
