import { describe, expect, it } from "vitest";
import type { MessageDto, MessagePartDto } from "@acpio/shared";
import {
  buildPromptRailItems,
  RAIL_CUT_HEIGHT_PX,
  RAIL_MAX_GAP_PX,
  RAIL_PILL_BASE_PX,
  RAIL_PILL_HEIGHT_PX,
  RAIL_PROMPT_CHARS,
  RAIL_REPLY_CHARS,
  railPillSlot,
  railPillWidth,
  railWindow,
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

  // A settled background job reaches the chat as a prompt — that is how the
  // agent is woken — so it sits in the transcript as a user message. It is not
  // a prompt the reader wrote, and the rail lists their prompts.
  it("keeps a background job's note out of the rail", () => {
    const note = [
      "[Фоновая задача] «wait10» завершилась: код 0, длительность 10s (id bg-6).",
      "Команда: sleep 10",
      "Последние строки вывода:",
      "готово",
    ].join("\n");
    const messages = [message("u1", "user", ["собери проект"]), message("u2", "user", [note])];

    const items = buildPromptRailItems(messages);

    expect(items.map((i) => i.id)).toEqual(["u1"]);
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

/** Height the rail actually paints: every drawn pill plus a marker per clipped end. */
function paintedHeight(view: ReturnType<typeof railWindow>): number {
  const cuts = (view.above > 0 ? 1 : 0) + (view.below > 0 ? 1 : 0);
  return view.count * view.slot + cuts * RAIL_CUT_HEIGHT_PX;
}

describe("railWindow", () => {
  it("draws every prompt while the column has room", () => {
    const view = railWindow(3, 2, 500);

    expect(view).toEqual({ start: 0, count: 3, above: 0, below: 0, slot: railPillSlot(3, 500, 3, 8) });
  });

  // The bug this guards: a chat with a few hundred prompts built a column taller
  // than the thread, so its pills ran over the header above and the composer
  // below. The window stops at the column's height and marks the clipped end.
  it("stops at the thread's height and marks the prompts clipped above", () => {
    const view = railWindow(300, 299, 600);

    expect(view.count).toBeLessThan(300);
    expect(view.below).toBe(0);
    expect(view.above).toBeGreaterThan(0);
    expect(view.start + view.count).toBe(300);
    expect(paintedHeight(view)).toBeLessThanOrEqual(600);
  });

  it("never paints past the thread, whatever the height and the prompt count", () => {
    // A column too short for a pill *and* a marker still overflows by design —
    // there is no smaller way to say "there is more" than a pill and its dots.
    const floor = RAIL_PILL_HEIGHT_PX + 2 * RAIL_CUT_HEIGHT_PX;
    for (const total of [0, 1, 5, 43, 200, 1000]) {
      for (const room of [0, 12, 40, 100, 679, 1600]) {
        for (const active of [-1, 0, 2, total - 1]) {
          const view = railWindow(total, active, room);

          expect(paintedHeight(view)).toBeLessThanOrEqual(Math.max(room, floor));
          expect(view.count).toBeLessThanOrEqual(total);
        }
      }
    }
  });

  it("keeps the lit prompt inside the window when the reader is far up the chat", () => {
    const active = 5;
    const view = railWindow(300, active, 600);

    expect(view.start).toBe(0);
    expect(active).toBeLessThan(view.start + view.count);
    // The rest of the chat is below the window, and the marker says so.
    expect(view.below).toBeGreaterThan(0);
  });

  it("marks both ends when the reader sits in the middle", () => {
    const view = railWindow(300, 250, 600);

    expect(view.above).toBeGreaterThan(0);
    expect(view.below).toBeGreaterThan(0);
    expect(view.start + view.count).toBeGreaterThan(250);
  });

  it("counts every prompt as clipped when there is no height at all", () => {
    expect(railWindow(0, 0, 0)).toEqual({ start: 0, count: 0, above: 0, below: 0, slot: RAIL_PILL_HEIGHT_PX });
    expect(railWindow(10, 9, 0)).toMatchObject({ count: 1, above: 9, below: 0 });
  });

  it("tightens the pitch to the pill's own height before it starts clipping", () => {
    const view = railWindow(100, 99, 100);

    expect(view.slot).toBeGreaterThanOrEqual(RAIL_PILL_HEIGHT_PX);
    expect(view.slot).toBeLessThanOrEqual(RAIL_PILL_HEIGHT_PX + RAIL_MAX_GAP_PX);
  });
});
