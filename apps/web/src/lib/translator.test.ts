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
    expect(ru("common.deleteUserConfirm", { username: "alice" })).toBe("Удалить пользователя @alice?");
    expect(en("common.deleteUserConfirm", { username: "alice" })).toBe("Delete user @alice?");
  });
});

describe("createTranslator: Russian plurals", () => {
  it.each([
    [1, "1 пользователь"],
    [21, "21 пользователь"],
    [101, "101 пользователь"],
  ])("count=%i selects the `one` form", (count, expected) => {
    expect(ru("common.userCount", { count })).toBe(expected);
  });

  it.each([
    [2, "2 пользователя"],
    [3, "3 пользователя"],
    [22, "22 пользователя"],
  ])("count=%i selects the `few` form", (count, expected) => {
    expect(ru("common.userCount", { count })).toBe(expected);
  });

  it.each([
    [0, "0 пользователей"],
    [5, "5 пользователей"],
    [11, "11 пользователей"],
    [14, "14 пользователей"],
  ])("count=%i selects the `many` form", (count, expected) => {
    expect(ru("common.userCount", { count })).toBe(expected);
  });

  it("combines the plural form with other interpolated variables", () => {
    expect(ru("common.thoughtFor", { count: 1, seconds: 3 })).toBe("Думал 3 секунду");
    expect(ru("common.thoughtFor", { count: 4, seconds: 3 })).toBe("Думал 3 секунды");
    expect(ru("common.thoughtFor", { count: 9, seconds: 3 })).toBe("Думал 3 секунд");
  });

  it("accepts a numeric string count", () => {
    expect(ru("common.userCount", { count: "3" })).toBe("3 пользователя");
  });
});

describe("createTranslator: English catalog ignores plural suffix logic", () => {
  it("uses the explicit en plural keys", () => {
    expect(en("common.userCount_one", { count: 1 })).toBe("1 user");
    expect(en("common.userCount_other", { count: 5 })).toBe("5 users");
  });

  it("does not select a plural form from a count variable", () => {
    expect(en("common.userCount", { count: 1 })).toBe("common.userCount");
  });

  it("interpolates count in relative-time keys", () => {
    expect(ru("common.relativeMinutes", { count: 5 })).toBe("5м");
    expect(en("common.relativeMinutes", { count: 5 })).toBe("5m");
  });
});
