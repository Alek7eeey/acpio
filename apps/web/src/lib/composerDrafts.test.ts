import { describe, it, expect, vi } from "vitest";

/** The registry is module state: a fresh import per test keeps them isolated. */
async function freshRegistry() {
  vi.resetModules();
  return import("./composerDrafts");
}

describe("hasUnsavedComposerAttachments", () => {
  it("reports nothing to lose before anything is typed", async () => {
    const { hasUnsavedComposerAttachments } = await freshRegistry();

    expect(hasUnsavedComposerAttachments()).toBe(false);
  });

  it("does not warn about typed text — drafts persist across a reload", async () => {
    const { hasUnsavedComposerAttachments, setComposerDraft } = await freshRegistry();
    setComposerDraft("s1", "напиши тест");

    expect(hasUnsavedComposerAttachments()).toBe(false);
  });

  it("keeps warning about the chips of an attachment-rich composer", async () => {
    const { hasUnsavedComposerAttachments, setComposerAttachments } = await freshRegistry();
    setComposerAttachments("s1", 2);

    expect(hasUnsavedComposerAttachments()).toBe(true);
    setComposerAttachments("s1", 0);
    expect(hasUnsavedComposerAttachments()).toBe(false);
  });
});

describe("readComposerDraft / setComposerDraft", () => {
  it("forgets the draft as soon as the composer is emptied", async () => {
    const { readComposerDraft, setComposerDraft } = await freshRegistry();
    setComposerDraft("s1", "черновик");
    setComposerDraft("s1", "");

    expect(readComposerDraft("s1")).toBe("");
  });

  it("drops the pre-chat pane token once the chat exists", async () => {
    const { discardComposerPaneWork, newComposerPaneKey, readComposerDraft, setComposerDraft } =
      await freshRegistry();
    const paneKey = newComposerPaneKey();
    setComposerDraft(paneKey, "первое сообщение");

    discardComposerPaneWork(paneKey);
    expect(readComposerDraft(paneKey)).toBe("");
  });
});

describe("composerDraftSnapshot / seedComposerDrafts", () => {
  it("persists only non-pane keys with real text", async () => {
    const { composerDraftSnapshot, newComposerPaneKey, setComposerDraft } = await freshRegistry();
    const paneKey = newComposerPaneKey();
    setComposerDraft(paneKey, "не в базу");
    setComposerDraft("s1", "сохрани меня");
    setComposerDraft("s2", "   \n ");

    expect(composerDraftSnapshot()).toEqual({ s1: "сохрани меня" });
  });

  it("restores a persisted map into the registry", async () => {
    const { readComposerDraft, seedComposerDrafts } = await freshRegistry();
    seedComposerDrafts({ s1: "восстановлен", s2: "", "pane:9": "игнор" });

    expect(readComposerDraft("s1")).toBe("восстановлен");
    expect(readComposerDraft("s2")).toBe("");
    expect(readComposerDraft("pane:9")).toBe("");
  });

  it("notifies the persist sink when a draft changes", async () => {
    const { setComposerDraft, setComposerDraftPersistSink } = await freshRegistry();
    let calls = 0;
    setComposerDraftPersistSink(() => {
      calls += 1;
    });

    setComposerDraft("s1", "текст");
    expect(calls).toBe(1);
  });
});
