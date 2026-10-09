import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightText, matchAny } from "./settingsSearch";

describe("settingsSearch single-character terms", () => {
  it("retains and highlights a single-character term like 'и'", () => {
    const html = renderToStaticMarkup(<>{highlightText("Поиск и настройки", "и")}</>);
    expect(html).toContain("<mark");
    expect(html).toContain(">и<");
  });

  it("requires the single-character term to be present for a match", () => {
    // "х" does not occur in these strings; "и" does (as a substring).
    expect(matchAny(["Поиск настройки"], "х")).toBe(false);
    expect(matchAny(["Поиск и настройки"], "и")).toBe(true);
  });

  it("highlights multi-word queries that include a single-character term", () => {
    const html = renderToStaticMarkup(
      <>{highlightText("настройки и параметры", "настройки и")}</>,
    );
    expect(html).toContain(">настройки<");
    expect(html).toContain(">и<");
  });

  it("does not highlight or require a genuinely absent single-character term", () => {
    const html = renderToStaticMarkup(<>{highlightText("настройки параметры", "х")}</>);
    expect(html).not.toContain("<mark");
    expect(matchAny(["настройки параметры"], "х")).toBe(false);
  });
});
