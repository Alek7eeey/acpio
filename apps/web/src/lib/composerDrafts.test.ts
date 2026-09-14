import { describe, it, expect, vi } from "vitest";

/** The registry is module state: a fresh import per test keeps them isolated. */
async function freshRegistry() {
  vi.resetModules();
  return import("./composerDrafts");
}

describe("hasUnsavedComposerWork", () => {
  it("reports nothing to lose before anything is typed", async () => {
    const { hasUnsavedComposerWork } = await freshRegistry();

    expect(hasUnsavedComposerWork()).toBe(false);
  });

  it("counts a draft typed into a chat", async () => {
    const { hasUnsavedComposerWork, readComposerDraft, setComposerDraft } = await freshRegistry();
    setComposerDraft("s1", "напиши тест");

    expect(hasUnsavedComposerWork()).toBe(true);
    expect(readComposerDraft("s1")).toBe("напиши тест");
  });

  it("forgets the draft as soon as the composer is emptied", async () => {
    const { hasUnsavedComposerWork, readComposerDraft, setComposerDraft } = await freshRegistry();
    setComposerDraft("s1", "черновик");
    setComposerDraft("s1", "");

    expect(hasUnsavedComposerWork()).toBe(false);
    expect(readComposerDraft("s1")).toBe("");
  });

  it("does not warn about whitespace alone", async () => {
    const { hasUnsavedComposerWork, setComposerDraft } = await freshRegistry();
    setComposerDraft("s1", "  \n\t ");

    expect(hasUnsavedComposerWork()).toBe(false);
  });

  it("keeps warning about the chips of an attachment-rich composer with empty text", async () => {
    const { hasUnsavedComposerWork, setComposerAttachments, setComposerDraft } =
      await freshRegistry();
    setComposerAttachments("s1", 2);
    setComposerDraft("s1", "");

    expect(hasUnsavedComposerWork()).toBe(true);
    setComposerAttachments("s1", 0);
    expect(hasUnsavedComposerWork()).toBe(false);
  });

  it("drops the pre-chat pane token once the chat exists", async () => {
    const { discardComposerPaneWork, hasUnsavedComposerWork, newComposerPaneKey, setComposerDraft } =
      await freshRegistry();
    const paneKey = newComposerPaneKey();
    setComposerDraft(paneKey, "первое сообщение");
    setComposerDraft("s1", "черновик в существующем чате");

    discardComposerPaneWork(paneKey);
    expect(hasUnsavedComposerWork()).toBe(true);

    setComposerDraft("s1", "");
    expect(hasUnsavedComposerWork()).toBe(false);
  });
});
