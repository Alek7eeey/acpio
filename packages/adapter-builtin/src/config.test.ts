import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings, type BuiltinProviderConfig } from "@acpio/shared";
import {
  builtinModelOptions,
  contextWindowOf,
  hasBuiltinEndpoint,
  initialModelId,
  resolveBuiltinModel,
  subagentModelChoice,
} from "./config.js";

function provider(overrides: Partial<BuiltinProviderConfig> = {}): BuiltinProviderConfig {
  return {
    id: "p1",
    name: "Ollama",
    url: "http://localhost:11434/v1",
    apiKey: "",
    models: [
      { id: "legacy", label: "Legacy", contextWindow: 1_000 },
      { id: "on", label: "On", contextWindow: 2_000 },
      { id: "off", label: "Off", contextWindow: 3_000, enabled: false },
    ],
    ...overrides,
  };
}

function withProviders(providers: BuiltinProviderConfig[]): AppSettings {
  return { ...DEFAULT_SETTINGS, builtinProviders: providers };
}

describe("builtinModelOptions", () => {
  it("offers enabled models as composite values, hiding switched-off rows", () => {
    expect(builtinModelOptions(withProviders([provider()]))).toEqual([
      expect.objectContaining({ value: "p1::legacy", name: "Legacy", modelId: "legacy" }),
      expect.objectContaining({ value: "p1::on", name: "On", modelId: "on" }),
    ]);
  });

  it("keeps labels plain across providers — the provider name rides beside them", () => {
    const options = builtinModelOptions(
      withProviders([
        provider(),
        provider({ id: "p2", name: "OpenRouter", models: [{ id: "on", label: "On", contextWindow: 2_000 }] }),
      ]),
    );
    expect(options.map((o) => [o.value, o.name, o.provider.name])).toEqual([
      ["p1::legacy", "Legacy", "Ollama"],
      ["p1::on", "On", "Ollama"],
      ["p2::on", "On", "OpenRouter"],
    ]);
  });

  it("heals blank labels and windows per provider", () => {
    const options = builtinModelOptions(
      withProviders([
        provider({
          models: [
            { id: "a", label: "", contextWindow: 0 },
            { id: "b", label: "Bee", contextWindow: 50_000_000 },
          ],
        }),
      ]),
    );
    expect(options.map((o) => [o.modelId, o.contextWindow])).toEqual([
      ["a", 128_000],
      ["b", 10_000_000],
    ]);
  });
});

describe("resolveBuiltinModel", () => {
  it("routes a composite value to its own provider", () => {
    const settings = withProviders([
      provider(),
      provider({ id: "p2", name: "OpenRouter", url: "https://openrouter.ai/api/v1" }),
    ]);
    const picked = resolveBuiltinModel(settings, "p2::legacy");
    expect(picked?.provider.id).toBe("p2");
    expect(picked?.provider.url).toBe("https://openrouter.ai/api/v1");
    expect(picked?.modelId).toBe("legacy");
    expect(picked?.value).toBe("p2::legacy");
  });

  it("resolves a bare id saved before providers existed to the first host", () => {
    const picked = resolveBuiltinModel(withProviders([provider()]), "on");
    expect(picked?.value).toBe("p1::on");
  });

  it("keeps resolving a model the user switched off", () => {
    expect(resolveBuiltinModel(withProviders([provider()]), "p1::off")).not.toBeNull();
    expect(contextWindowOf(withProviders([provider()]), "p1::off")).toBe(3_000);
  });

  it("returns null for unknown values", () => {
    expect(resolveBuiltinModel(withProviders([provider()]), "p1::gone")).toBeNull();
    expect(resolveBuiltinModel(withProviders([provider()]), "gone")).toBeNull();
    expect(resolveBuiltinModel(withProviders([]), "p1::on")).toBeNull();
    expect(resolveBuiltinModel(withProviders([provider()]), "  ")).toBeNull();
  });
});

describe("contextWindowOf", () => {
  it("falls back to the assumed window for an unknown value", () => {
    expect(contextWindowOf(withProviders([provider()]), "p1::gone")).toBe(128_000);
    expect(contextWindowOf(withProviders([]), "p1::on")).toBe(128_000);
  });
});

describe("initialModelId", () => {
  it("offers the first enabled model as the fallback default", () => {
    expect(initialModelId(withProviders([provider()]))).toBe("p1::legacy");
    expect(initialModelId(withProviders([]))).toBe("");
  });

  it("keeps a valid stored default and normalizes a bare one to composite", () => {
    const bare: AppSettings = { ...DEFAULT_SETTINGS, defaultModelByProvider: { builtin: "on" } };
    expect(initialModelId({ ...bare, builtinProviders: [provider()] })).toBe("p1::on");

    const pinned: AppSettings = {
      ...DEFAULT_SETTINGS,
      builtinProviders: [provider()],
      defaultModelByProvider: { builtin: "p1::on" },
    };
    expect(initialModelId(pinned)).toBe("p1::on");
  });

  it("falls back when the stored default no longer exists", () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      builtinProviders: [provider()],
      defaultModelByProvider: { builtin: "p1::gone" },
    };
    expect(initialModelId(settings)).toBe("p1::legacy");
  });
});

describe("hasBuiltinEndpoint", () => {
  it("requires at least one provider with a URL", () => {
    expect(hasBuiltinEndpoint(withProviders([]))).toBe(false);
    expect(hasBuiltinEndpoint(withProviders([provider({ url: "" })]))).toBe(false);
    expect(hasBuiltinEndpoint(withProviders([provider()]))).toBe(true);
  });
});

describe("subagentModelChoice", () => {
  it("inherits the session model when no subagent model is configured", () => {
    const settings = withProviders([provider()]);
    const parent = builtinModelOptions(settings)[0]!;
    expect(subagentModelChoice(settings, parent)).toEqual({ selection: parent, fellBack: false });
  });

  it("resolves the configured composite value, keeping its context window", () => {
    const settings: AppSettings = {
      ...withProviders([provider()]),
      builtinSubagents: { enabled: true, allowAdhoc: true, agents: [], model: "p1::on" },
    };
    const parent = builtinModelOptions(settings)[0]!;
    expect(parent.value).toBe("p1::legacy");
    expect(subagentModelChoice(settings, parent)).toEqual({
      selection: expect.objectContaining({ value: "p1::on", contextWindow: 2_000 }),
      fellBack: false,
    });
  });

  it("falls back to the session model when the configured value is gone", () => {
    const settings: AppSettings = {
      ...withProviders([provider()]),
      builtinSubagents: { enabled: true, allowAdhoc: true, agents: [], model: "p1::ghost" },
    };
    const parent = builtinModelOptions(settings)[0]!;
    expect(subagentModelChoice(settings, parent)).toEqual({ selection: parent, fellBack: true });
  });
});
