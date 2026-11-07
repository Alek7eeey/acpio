import { describe, expect, it } from "vitest";
import { toolsForPath } from "./editorTools";

describe("toolsForPath", () => {
  it("gives a TypeScript file all three tools", () => {
    expect(toolsForPath("src/app.tsx")).toEqual(["typescript", "oxlint", "oxfmt"]);
    expect(toolsForPath("bin/cli.mjs")).toEqual(["typescript", "oxlint", "oxfmt"]);
  });

  it("gives data, styles and prose the formatter only", () => {
    expect(toolsForPath("global.json")).toEqual(["oxfmt"]);
    expect(toolsForPath("theme.scss")).toEqual(["oxfmt"]);
    expect(toolsForPath("README.md")).toEqual(["oxfmt"]);
  });

  it("gives a language it has no tool for nothing at all", () => {
    expect(toolsForPath("ConsoleServer/Program.cs")).toEqual([]);
    expect(toolsForPath("notes.txt")).toEqual([]);
    expect(toolsForPath(null)).toEqual([]);
    expect(toolsForPath("")).toEqual([]);
  });

  it("is not fooled by a folder that looks like an extension", () => {
    expect(toolsForPath("src.ts/readme")).toEqual([]);
  });
});
