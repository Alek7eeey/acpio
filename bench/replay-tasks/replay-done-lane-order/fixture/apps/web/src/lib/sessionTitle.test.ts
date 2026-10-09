import { describe, expect, it } from "vitest";
import { localizePlaceholderSessionTitle, sessionTreeDisplayTitle } from "./sessionTitle";

describe("localizePlaceholderSessionTitle", () => {
  it("maps Russian default title to English", () => {
    expect(localizePlaceholderSessionTitle("Новый чат", "New chat")).toBe("New chat");
  });

  it("maps English default title to Russian", () => {
    expect(localizePlaceholderSessionTitle("New chat", "Новый чат")).toBe("Новый чат");
  });

  it("keeps a custom title", () => {
    expect(localizePlaceholderSessionTitle("Deploy Acpio", "New chat")).toBe("Deploy Acpio");
  });

  it("keeps the shell suffix", () => {
    expect(localizePlaceholderSessionTitle("Новый чат-shell", "New chat")).toBe("New chat-shell");
  });
});

describe("sessionTreeDisplayTitle", () => {
  it("localizes then adds -shell for shell sessions", () => {
    expect(sessionTreeDisplayTitle("Новый чат", "shell", "New chat")).toBe("New chat-shell");
  });
});
