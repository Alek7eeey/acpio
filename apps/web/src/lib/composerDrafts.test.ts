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

    expect(composerDraftSnapshot()).toEqual({ s1: { text: "сохрани меня", files: [] } });
  });

  it("restores a persisted map into the registry", async () => {
    const { readComposerDraft, seedComposerDrafts } = await freshRegistry();
    seedComposerDrafts({
      s1: { text: "восстановлен", files: [] },
      s2: { text: "", files: [] },
      "pane:9": { text: "игнор", files: [] },
    });

    expect(readComposerDraft("s1")).toBe("восстановлен");
    expect(readComposerDraft("s2")).toBe("");
    expect(readComposerDraft("pane:9")).toBe("");
  });

  // The field names a staged file by its name alone, so the path its link is
  // written with has to travel with the draft — otherwise a reload leaves a
  // link that points at nothing.
  it("carries the files a draft's links name through a reload", async () => {
    const {
      composerDraftSnapshot,
      readComposerDraftFiles,
      seedComposerDrafts,
      setComposerDraft,
      setComposerDraftFiles,
    } = await freshRegistry();
    const shot = { name: "shot.png", path: "E:/proj/.acpio-attachments/s1/shot.png" };
    setComposerDraft("s1", "посмотри [shot.png]()");
    setComposerDraftFiles("s1", [shot]);

    const persisted = composerDraftSnapshot();
    expect(persisted).toEqual({ s1: { text: "посмотри [shot.png]()", files: [shot] } });

    vi.resetModules();
    const restarted = await import("./composerDrafts");
    restarted.seedComposerDrafts(persisted);
    expect(restarted.readComposerDraft("s1")).toBe("посмотри [shot.png]()");
    expect(restarted.readComposerDraftFiles("s1")).toEqual([shot]);
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
