// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listLikedMessages,
  saveLikedMessage,
  removeLikedMessage,
  subscribeLikedMessages,
  type LikedMessage,
} from "./likedMessages";

function entry(overrides: Partial<LikedMessage> = {}): LikedMessage {
  return {
    messageId: "m1",
    sessionId: "s1",
    sessionTitle: "Chat",
    text: "hello",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("listLikedMessages", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(listLikedMessages()).toEqual([]);
  });

  it("returns an empty list when stored JSON is invalid", () => {
    localStorage.setItem("acprocess.likedMessages.v1", "{not json");
    expect(listLikedMessages()).toEqual([]);
  });

  it("returns an empty list when stored JSON is not an array", () => {
    localStorage.setItem("acprocess.likedMessages.v1", JSON.stringify({ messageId: "m1" }));
    expect(listLikedMessages()).toEqual([]);
  });

  it("sorts stored entries by `at` descending", () => {
    localStorage.setItem(
      "acprocess.likedMessages.v1",
      JSON.stringify([
        entry({ messageId: "old", at: "2026-01-01T00:00:00.000Z" }),
        entry({ messageId: "new", at: "2026-02-01T00:00:00.000Z" }),
        entry({ messageId: "mid", at: "2026-01-15T00:00:00.000Z" }),
      ]),
    );
    expect(listLikedMessages().map((m) => m.messageId)).toEqual(["new", "mid", "old"]);
  });
});

describe("saveLikedMessage", () => {
  it("persists the entry and returns it via listLikedMessages", () => {
    const saved = saveLikedMessage(entry());
    expect(saved).toEqual([entry()]);
    expect(listLikedMessages()).toEqual([entry()]);
  });

  it("replaces an existing entry with the same messageId", () => {
    saveLikedMessage(entry());
    const updated = saveLikedMessage(entry({ text: "edited", at: "2026-03-01T00:00:00.000Z" }));
    expect(updated).toHaveLength(1);
    expect(listLikedMessages()).toEqual([entry({ text: "edited", at: "2026-03-01T00:00:00.000Z" })]);
  });

  it("caps the stored text at 600 characters", () => {
    const long = "x".repeat(900);
    saveLikedMessage(entry({ text: long }));
    expect(listLikedMessages()[0].text).toHaveLength(600);
  });

  it("keeps text shorter than the cap unchanged", () => {
    saveLikedMessage(entry({ text: "short" }));
    expect(listLikedMessages()[0].text).toBe("short");
  });
});

describe("removeLikedMessage", () => {
  it("removes the entry with the given messageId", () => {
    saveLikedMessage(entry({ messageId: "m1" }));
    saveLikedMessage(entry({ messageId: "m2" }));
    const next = removeLikedMessage("m1");
    expect(next.map((m) => m.messageId)).toEqual(["m2"]);
    expect(listLikedMessages().map((m) => m.messageId)).toEqual(["m2"]);
  });

  it("returns the list unchanged when the messageId is absent", () => {
    saveLikedMessage(entry());
    const next = removeLikedMessage("nope");
    expect(next).toHaveLength(1);
    expect(listLikedMessages()).toEqual([entry()]);
  });
});

describe("subscribeLikedMessages", () => {
  it("notifies the listener when a message is saved", () => {
    const listener = vi.fn();
    subscribeLikedMessages(listener);
    saveLikedMessage(entry());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies the listener when a message is removed", () => {
    const listener = vi.fn();
    subscribeLikedMessages(listener);
    saveLikedMessage(entry());
    removeLikedMessage("m1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after the returned unsubscribe is called", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLikedMessages(listener);
    unsubscribe();
    saveLikedMessage(entry());
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("persistence error tolerance", () => {
  it("still returns the next list and dispatches the event when localStorage.setItem throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const listener = vi.fn();
      subscribeLikedMessages(listener);
      const next = saveLikedMessage(entry());
      expect(next).toEqual([entry()]);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });
});
