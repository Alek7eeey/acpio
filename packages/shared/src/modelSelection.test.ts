import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  RECENT_MODELS_LIMIT,
  pushRecentModel,
  resolveParamsForModel,
  type AppSettings,
} from "./index.js";

const effortSchema = [
  { id: "effort", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
];

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("resolveParamsForModel", () => {
  it("falls back to the provider default when the model has no explicit pick", () => {
    const s = settingsWith({ defaultModelParamsByProvider: { omp: { effort: "high" } } });
    expect(resolveParamsForModel(s, "omp", "gpt-4o", effortSchema)).toEqual({ effort: "high" });
  });

  it("an explicit per-model pick overrides the provider default", () => {
    const s = settingsWith({
      defaultModelParamsByProvider: { omp: { effort: "high" } },
      modelParamsByProviderModel: { omp: { "gpt-4o": { effort: "low" } } },
    });
    expect(resolveParamsForModel(s, "omp", "gpt-4o", effortSchema)).toEqual({ effort: "low" });
  });

  it("other providers' values never leak in", () => {
    const s = settingsWith({
      defaultModelParamsByProvider: { cursor: { effort: "high" } },
      modelParamsByProviderModel: { cursor: { "gpt-4o": { effort: "low" } } },
    });
    expect(resolveParamsForModel(s, "omp", "gpt-4o", effortSchema)).toEqual({});
  });

  it("alias-migrates stored effort onto a reasoning-shaped schema", () => {
    const s = settingsWith({
      defaultModelParamsByProvider: { omp: { effort: "medium" } },
      modelParamsByProviderModel: { omp: { "claude": { effort: "high" } } },
    });
    const reasoningSchema = [
      { id: "reasoning", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
    ];
    // The explicit claude pick wins and lands on the exposed `reasoning` id.
    expect(resolveParamsForModel(s, "omp", "claude", reasoningSchema)).toEqual({
      reasoning: "high",
    });
    // A model without an explicit pick gets the migrated provider default.
    expect(resolveParamsForModel(s, "omp", "gpt-4o", reasoningSchema)).toEqual({
      reasoning: "medium",
    });
  });

  it("keeps the provider default for families the explicit pick does not cover", () => {
    const s = settingsWith({
      defaultModelParamsByProvider: { omp: { effort: "high", fast: "true" } },
      modelParamsByProviderModel: { omp: { "gpt-4o": { effort: "low" } } },
    });
    const schema = [
      ...effortSchema,
      { id: "fast", options: [{ value: "true" }, { value: "false" }] },
    ];
    expect(resolveParamsForModel(s, "omp", "gpt-4o", schema)).toEqual({
      effort: "low",
      fast: "true",
    });
  });
});

describe("pushRecentModel", () => {
  it("puts the model at the head of an empty list", () => {
    expect(pushRecentModel(undefined, "gpt-4o")).toEqual(["gpt-4o"]);
  });

  it("moves a re-used model to the head without duplicating", () => {
    expect(pushRecentModel(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("caps history at the limit, dropping the oldest", () => {
    let list: string[] = [];
    for (let i = 0; i < RECENT_MODELS_LIMIT + 3; i += 1) {
      list = pushRecentModel(list, `m${i}`);
    }
    expect(list).toHaveLength(RECENT_MODELS_LIMIT);
    expect(list[0]).toBe(`m${RECENT_MODELS_LIMIT + 2}`);
    expect(list).not.toContain("m0");
  });

  it("ignores blank models", () => {
    expect(pushRecentModel(["a"], "   ")).toEqual(["a"]);
  });
});
