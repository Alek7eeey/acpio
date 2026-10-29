import type { ComposerDraft, ComposerDraftFile } from "@acpio/shared";

/**
 * Composer drafts and staged attachment chips, keyed by chat.
 *
 * Deliberately outside React and outside the store: a draft outlives the pane
 * that typed it (switching chats keeps it), and the reload guard has to answer
 * "would a reload lose typed text right now?" without subscribing to the
 * composer tree. The text half of each entry is mirrored into persisted app
 * settings (`composerDrafts`) so it also survives a reload — see `persist`.
 *
 * The chips themselves are not persisted (a reload cannot bring back a local
 * preview), but the files they staged are: the field names a file by its name
 * alone (`[shot.png]()`), so the path that link is written with has to outlive
 * the reload too — a chip comes back from it, ready, with no bytes to upload.
 *
 * A composer with no chat yet (a fresh pane, nothing to key on) uses its own
 * pane token; that text has no server-side copy until the chat is created.
 */
type ComposerWork = {
  text: string;
  attachments: number;
  /** Files the text names by name, in the order the chips staged them. */
  files: ComposerDraftFile[];
};

const work = new Map<string, ComposerWork>();

/** Set by the store so the registry can mirror its text into persisted settings
 *  without importing the store (which would create a cycle). */
let persistSink: (() => void) | null = null;
export function setComposerDraftPersistSink(sink: () => void): void {
  persistSink = sink;
}

const PANE_PREFIX = "pane:";
let paneTokens = 0;

/** Key for a composer that has no chat id yet. */
export function newComposerPaneKey(): string {
  paneTokens += 1;
  return `${PANE_PREFIX}${paneTokens}`;
}

/** Reload guard now that drafts persist: only staged attachment chips are lost. */
export function hasUnsavedComposerAttachments(): boolean {
  for (const entry of work.values()) {
    if (entry.attachments > 0) return true;
  }
  return false;
}

export function readComposerDraft(key: string): string {
  return work.get(key)?.text ?? "";
}

/** Entries exist only while they hold something; keeping empty ones would pin
 *  the guard on forever. */
function liveEntry(key: string): ComposerWork {
  let entry = work.get(key);
  if (!entry) {
    entry = { text: "", attachments: 0, files: [] };
    work.set(key, entry);
  }
  return entry;
}

function dropIfEmpty(key: string, entry: ComposerWork): void {
  if (!entry.text.trim() && entry.attachments === 0) work.delete(key);
}

export function setComposerDraft(key: string, text: string): void {
  if (!key) return;
  const entry = liveEntry(key);
  entry.text = text;
  dropIfEmpty(key, entry);
  persistSink?.();
}

export function setComposerAttachments(key: string, count: number): void {
  if (!key) return;
  const entry = liveEntry(key);
  entry.attachments = count;
  dropIfEmpty(key, entry);
  persistSink?.();
}

/** The staged files the draft's links name — a chip is rebuilt from one when
 *  the draft comes back after a reload. */
export function setComposerDraftFiles(key: string, files: ComposerDraftFile[]): void {
  if (!key) return;
  const entry = liveEntry(key);
  entry.files = files;
  dropIfEmpty(key, entry);
  persistSink?.();
}

export function readComposerDraftFiles(key: string): ComposerDraftFile[] {
  return work.get(key)?.files ?? [];
}

/** A chat is bound now, so the pane's pre-chat token is dead weight. */
export function discardComposerPaneWork(key: string): void {
  if (key.startsWith(PANE_PREFIX)) work.delete(key);
}

/** Drop one chat's persisted draft entirely (deleted chat). */
export function forgetComposerDraft(key: string): void {
  if (work.delete(key)) persistSink?.();
}

/** Persistable snapshot: non-pane keys with non-empty trimmed text, and the
 *  files their links name. */
export function composerDraftSnapshot(): Record<string, ComposerDraft> {
  const out: Record<string, ComposerDraft> = {};
  for (const [key, entry] of work) {
    if (key.startsWith(PANE_PREFIX)) continue;
    if (!entry.text.trim()) continue;
    out[key] = { text: entry.text, files: entry.files };
  }
  return out;
}

/** Seed the registry from persisted settings at boot (before any pane mounts). */
export function seedComposerDrafts(drafts: Record<string, ComposerDraft>): void {
  for (const [key, value] of Object.entries(drafts ?? {})) {
    if (!key || key.startsWith(PANE_PREFIX)) continue;
    if (!value || typeof value.text !== "string" || !value.text.trim()) continue;
    const entry = liveEntry(key);
    entry.text = value.text;
    entry.files = Array.isArray(value.files) ? value.files : [];
  }
}
