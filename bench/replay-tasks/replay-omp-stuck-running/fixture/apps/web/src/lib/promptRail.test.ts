import { describe, expect, it } from "vitest";
import type { MessageDto, MessagePartDto } from "@acpio/shared";
import {
  buildPromptRailItems,
  RAIL_PROMPT_CHARS,
  RAIL_REPLY_CHARS,
  RAIL_PILL_BASE_PX,
  railPillSlot,
  railPillWidth,
} from "./promptRail.js";

function part(id: string, text: string): MessagePartDto {
  return {
    id,
    messageId: id,
    type: "text",
    order: 0,
    payload: { text },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function message(id: string, role: MessageDto["role"], texts: string[]): MessageDto {
  return {
    id,
    sessionId: "s1",
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    parts: texts.map((text, i) => part(`${id}-p${i}`, text)),
  };
}

describe("buildPromptRailItems", () => {
  it("gives one item per user prompt, in order, and ignores the agent's turns", () => {
    const messages = [
      message("u1", "user", ["first prompt"]),
      message("a1", "assistant", ["first answer"]),
      message("u2", "user", ["second prompt"]),
      message("a2", "assistant", ["second answer"]),
    ];

    const items = buildPromptRailItems(messages);

    expect(items.map((i) => i.id)).toEqual(["u1", "u2"]);
    expect(items.map((i) => i.prompt)).toEqual(["first prompt", "second prompt"]);
  });

  it("shows the head of the answer that followed the prompt", () => {
    const messages = [
      message("u1", "user", ["prompt"]),
      message("a1", "assistant", ["thinking out loud"]),
      message("a2", "assistant", ["the answer"]),
      message("u2", "user", ["next"]),
    ];

    const items = buildPromptRailItems(messages);

    expect(items[0]!.reply).toBe("thinking out loud\n\nthe answer");
    expect(items[1]!.reply).toBe("");
  });

  it("keeps the rail free of attachment-only prompts and empty chats", () => {
    const attachmentOnly = message("u1", "user", []);
    attachmentOnly.parts = [
      {
        id: "u1-f0",
        messageId: "u1",
        type: "file",
        order: 0,
        payload: { path: "a.png" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    expect(buildPromptRailItems([attachmentOnly])).toEqual([]);
    expect(buildPromptRailItems([])).toEqual([]);
  });

  it("clips long prompts and answers to a glance", () => {
    const long = "word ".repeat(300);
    const messages = [message("u1", "user", [long]), message("a1", "assistant", [long])];

    const items = buildPromptRailItems(messages);

    expect(items[0]!.prompt.length).toBeLessThanOrEqual(RAIL_PROMPT_CHARS + 1);
    expect(items[0]!.prompt.endsWith("…")).toBe(true);
    expect(items[0]!.reply.length).toBeLessThanOrEqual(RAIL_REPLY_CHARS + 1);
    expect(items[0]!.reply.endsWith("…")).toBe(true);
  });
});

describe("railPillWidth", () => {
  it("makes the hovered pill the crest and its neighbours the swell", () => {
    expect(railPillWidth(0)).toBeGreaterThan(railPillWidth(1));
    expect(railPillWidth(1)).toBeGreaterThan(railPillWidth(2));
    expect(railPillWidth(2)).toBeGreaterThan(railPillWidth(3));
  });

  it("leaves every pill further out at rest", () => {
    expect(railPillWidth(3)).toBe(RAIL_PILL_BASE_PX);
    expect(railPillWidth(99)).toBe(RAIL_PILL_BASE_PX);
  });
});

describe("railPillSlot", () => {
  it("uses the roomiest pitch while the column has room", () => {
    expect(railPillSlot(5, 500, 3, 8)).toBe(11);
  });

  it("tightens the pitch when the chat is too short for that many prompts", () => {
    // 20 pills in 100px: each one may take 5px.
    expect(railPillSlot(20, 100, 3, 8)).toBe(5);
  });

  it("keeps the column inside the thread for a realistic session", () => {
    const slot = railPillSlot(43, 679, 3, 8);

    expect(slot * 43).toBeLessThanOrEqual(679);
  });

  it("never shrinks a pill below its own height", () => {
    expect(railPillSlot(100, 50, 3, 8)).toBe(3);
  });

  it("still gives a lone pill a usable hit area", () => {
    expect(railPillSlot(1, 500, 3, 8)).toBe(11);
  });
});
