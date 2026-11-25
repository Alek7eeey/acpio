// @vitest-environment jsdom
//
// A chat's mode is a skill in front of the reader's words, not a switch on the
// agent: `withComposerMode` is the only place the prefix lands, and the bubble
// takes it back off. Agent mode must leave the text byte-for-byte alone.
import { beforeEach, describe, expect, it } from "vitest";
import {
  composerModeOf,
  nextComposerMode,
  readComposerModes,
  storeComposerMode,
  stripComposerMode,
  withComposerMode,
} from "./composerMode";

beforeEach(() => localStorage.clear());

describe("withComposerMode", () => {
  it("leaves agent-mode text exactly as typed", () => {
    expect(withComposerMode("переписать парсер", "agent")).toBe("переписать парсер");
    expect(withComposerMode("", "agent")).toBe("");
  });

  it("puts the skill in front of the words, with the space it needs", () => {
    expect(withComposerMode("переписать парсер", "plan")).toBe("/plan переписать парсер");
    expect(withComposerMode("почему падает", "investigate")).toBe("/investigate почему падает");
    // A multi-line draft keeps its shape: only the head is touched.
    expect(withComposerMode("первая\nвторая", "ask")).toBe("/ask первая\nвторая");
  });

  it("backs off an explicit command the reader typed themselves", () => {
    expect(withComposerMode("/compact", "plan")).toBe("/compact");
    expect(withComposerMode("  /ask про это", "plan")).toBe("  /ask про это");
  });
});

describe("nextComposerMode", () => {
  it("steps the menu's order and wraps the last mode back to the first", () => {
    expect(nextComposerMode("agent")).toBe("plan");
    expect(nextComposerMode("plan")).toBe("ask");
    expect(nextComposerMode("ask")).toBe("investigate");
    expect(nextComposerMode("investigate")).toBe("agent");
  });
});

describe("composerModeOf / stripComposerMode", () => {
  it("reads the mode off the message and hides the token", () => {
    expect(composerModeOf("/plan переписать парсер")).toBe("plan");
    expect(stripComposerMode("/plan переписать парсер")).toBe("переписать парсер");
    expect(stripComposerMode("/investigate почему падает")).toBe("почему падает");
    // The whole message was the mode: nothing but the badge is left.
    expect(stripComposerMode("/ask")).toBe("");
  });

  it("does not mistake a longer name or a word in the middle for the mode", () => {
    expect(composerModeOf("/planning переписать")).toBe("agent");
    expect(stripComposerMode("/planning переписать")).toBe("/planning переписать");
    expect(composerModeOf("про /plan в тексте")).toBe("agent");
    expect(stripComposerMode("про /plan в тексте")).toBe("про /plan в тексте");
  });
});

describe("the stored mode", () => {
  it("survives a reload per chat and forgets agent", () => {
    storeComposerMode("s1", "plan");
    storeComposerMode("s2", "ask");
    expect(readComposerModes()).toEqual({ s1: "plan", s2: "ask" });

    // Back to agent is the default: nothing left to remember for that chat.
    storeComposerMode("s1", "agent");
    expect(readComposerModes()).toEqual({ s2: "ask" });
  });

  it("ignores a file a hand edit left unreadable", () => {
    localStorage.setItem("acpio.composerModes.v1", '{"s1":"bogus","s2":"plan"}');
    expect(readComposerModes()).toEqual({ s2: "plan" });
    localStorage.setItem("acpio.composerModes.v1", "not json");
    expect(readComposerModes()).toEqual({});
  });
});
