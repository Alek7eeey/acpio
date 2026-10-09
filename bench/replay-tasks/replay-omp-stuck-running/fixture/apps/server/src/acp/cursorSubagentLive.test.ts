import { describe, expect, it } from "vitest";
import { cursorProjectSlugs } from "@acpio/adapter-cursor";
import { agentIdFromToolText } from "./cursorSubagentLive.js";

describe("agentIdFromToolText", () => {
  it("extracts Agent ID from background Task result", () => {
    const text =
      "Subagent is running in the background.\n\nAgent ID: 09df7379-e56f-4ee6-990d-f5eb035fa974 (can be used with the resume parameter)";
    expect(agentIdFromToolText(text)).toBe("09df7379-e56f-4ee6-990d-f5eb035fa974");
  });

  it("returns undefined when missing", () => {
    expect(agentIdFromToolText("done")).toBeUndefined();
  });
});

describe("cursorProjectSlugs", () => {
  it("maps Windows cwd to Cursor project folder candidates", () => {
    const slugs = cursorProjectSlugs("E:\\testYura");
    expect(slugs).toContain("E-testYura");
    expect(slugs).toContain("e-testYura");
  });

  it("maps nested share path", () => {
    const slugs = cursorProjectSlugs("E:\\share\\acpio");
    expect(slugs.some((s) => /share-acpio/i.test(s))).toBe(true);
  });
});
