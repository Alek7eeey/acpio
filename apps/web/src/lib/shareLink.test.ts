// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chatLink } from "./shareLink";

describe("chatLink", () => {
  // The chat's own link is what the tree and the board copy: the chat, no
  // message, so the reader lands on its latest turn.
  it("points at the chat", () => {
    expect(chatLink("s1")).toBe(`${window.location.origin}/chat?session=s1`);
  });

  // Same link the message's share copies: the chat, then the message in it.
  it("adds the message when one is named", () => {
    expect(chatLink("s1", "m2")).toBe(`${window.location.origin}/chat?session=s1&message=m2`);
  });

  // Ids are opaque — an id with a slash or a space must survive the trip.
  it("escapes ids", () => {
    expect(chatLink("a/b c")).toBe(`${window.location.origin}/chat?session=a%2Fb%20c`);
  });
});
