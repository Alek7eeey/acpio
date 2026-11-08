import { describe, expect, it } from "vitest";
import { languageIdOf, toCompletions } from "./tsLsp";

describe("languageIdOf", () => {
  it("hands tsserver only the files it can speak for", () => {
    expect(languageIdOf("a/b.ts")).toBe("typescript");
    expect(languageIdOf("a/b.tsx")).toBe("typescriptreact");
    expect(languageIdOf("a/b.cjs")).toBe("javascript");
    expect(languageIdOf("a/b.json")).toBe("json");
    // Nothing a CSS, YAML or Markdown document says may come back as a JS hint.
    expect(languageIdOf("a/b.css")).toBeNull();
    expect(languageIdOf("a/b.yml")).toBeNull();
    expect(languageIdOf("a/b.md")).toBeNull();
    expect(languageIdOf("a/b.py")).toBeNull();
  });
});

describe("toCompletions", () => {
  it("keeps the server's order, type and detail", () => {
    const out = toCompletions([
      { label: "local", kind: 6, detail: "const local: number", sortText: "11" },
      { label: "buildApp", kind: 3, sortText: "12" },
    ]);
    expect(out.map((item) => item.label)).toEqual(["local", "buildApp"]);
    expect(out[0]).toMatchObject({
      detail: "const local: number",
      sortText: "11",
      type: "variable",
    });
    expect(out[1].type).toBe("function");
  });

  it("reads a CompletionList and its markup documentation", () => {
    const out = toCompletions({
      isIncomplete: false,
      items: [{ label: "x", documentation: { kind: "markdown", value: "the docs" } }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "x", info: "the docs", type: "text" });
  });

  it("keeps a plain name rather than re-typing the dot tsserver's range starts on", () => {
    const [dot, fn] = toCompletions([
      { label: "one", textEdit: { newText: ".one" } },
      { label: "build", insertText: "build()" },
    ]);
    expect(dot.apply).toBeUndefined();
    expect(fn.apply).toBe("build()");
  });

  it("never lets a snippet's placeholders reach the buffer", () => {
    const [item] = toCompletions([{ label: "fn", kind: 15, insertText: "fn($1)" }]);
    expect(item.apply).toBeUndefined();
  });

  it("answers nothing for a missing or malformed reply", () => {
    expect(toCompletions(null)).toEqual([]);
    expect(toCompletions({ items: [{ detail: "no label" }, null] })).toEqual([]);
  });
});
