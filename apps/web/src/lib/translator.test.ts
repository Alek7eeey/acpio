import { describe, it, expect } from "vitest";
import { createTranslator } from "./translator";
import type { AppLocale } from "@acpio/shared";

const ru = createTranslator("ru");
const en = createTranslator("en");

describe("createTranslator: direct catalog lookups", () => {
  it("resolves a top-level section key from the ru catalog", () => {
    expect(ru("common.save")).toBe("Сохранить");
  });

  it("resolves a top-level section key from the en catalog", () => {
    expect(en("common.save")).toBe("Save");
  });

  it("resolves deep nested keys", () => {
    expect(ru("common.newChat")).toBe("Новый чат");
    expect(en("common.newChat")).toBe("New chat");
  });

  it("returns the key itself when it exists in neither catalog", () => {
    expect(ru("common.nope.missing")).toBe("common.nope.missing");
    expect(en("common.nope.missing")).toBe("common.nope.missing");
  });

  it("returns the key itself when the key points at a non-string node", () => {
    expect(ru("common")).toBe("common");
  });

  it("uses the ru catalog for unknown locales", () => {
    const fr = createTranslator("fr" as AppLocale);
    expect(fr("common.save")).toBe("Сохранить");
  });
});

describe("createTranslator: interpolation", () => {
  it("substitutes all {{var}} placeholders", () => {
    expect(ru("common.agentStatus", { agent: "X", status: "ok" })).toBe("Агент: X · ok");
    expect(en("common.agentStatus", { agent: "X", status: "ok" })).toBe("Agent: X · ok");
  });

  it("replaces missing variables with an empty string", () => {
    expect(ru("common.agentStatus", { agent: "X" })).toBe("Агент: X · ");
  });

  it("interpolates without a count", () => {
    expect(ru("common.backToBoard", { name: "Roadmap" })).toBe("Назад к доске «Roadmap»");
    expect(en("common.backToBoard", { name: "Roadmap" })).toBe("Back to board «Roadmap»");
  });
});

describe("createTranslator: Russian plurals", () => {
  it.each([
    [1, "1 дамп"],
    [21, "21 дамп"],
    [101, "101 дамп"],
  ])("count=%i selects the `one` form", (count, expected) => {
    expect(ru("diagnostics.dumpsSummary", { count, size: "1 KB" })).toBe(`${expected} · 1 KB`);
  });

  it.each([
    [2, "2 дампа"],
    [3, "3 дампа"],
    [22, "22 дампа"],
  ])("count=%i selects the `few` form", (count, expected) => {
    expect(ru("diagnostics.dumpsSummary", { count, size: "1 KB" })).toBe(`${expected} · 1 KB`);
  });

  it.each([
    [0, "0 дампов"],
    [5, "5 дампов"],
    [11, "11 дампов"],
    [14, "14 дампов"],
  ])("count=%i selects the `many` form", (count, expected) => {
    expect(ru("diagnostics.dumpsSummary", { count, size: "1 KB" })).toBe(`${expected} · 1 KB`);
  });

  it("accepts a numeric string count", () => {
    expect(ru("diagnostics.dumpsSummary", { count: "3", size: "1 KB" })).toBe("3 дампа · 1 KB");
  });
});

describe("createTranslator: English catalog ignores plural suffix logic", () => {
  it("does not select a plural form from a count variable", () => {
    expect(en("diagnostics.dumpsSummary", { count: 1, size: "1 KB" })).toBe("1 dumps · 1 KB");
  });

  it("interpolates count in relative-time keys", () => {
    expect(ru("common.relativeMinutes", { count: 5 })).toBe("5м");
    expect(en("common.relativeMinutes", { count: 5 })).toBe("5m");
  });
});
