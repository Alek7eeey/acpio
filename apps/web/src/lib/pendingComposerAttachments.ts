/**
 * Server-staged files waiting to land in a chat's composer as chips, keyed by
 * chat id. A chat created from "new chat based on this chat" starts with the
 * exported transcript already attached: the board stages it here, ChatPage
 * takes it on activation. The path is already on the server, so the chip is
 * ready — no upload. Deliberately outside the store: chips live until the
 * chat is opened, not as long as the store keeps the row.
 */
export type StagedComposerAttachment = { name: string; path: string; size?: number };

const staged = new Map<string, StagedComposerAttachment[]>();

export function stageComposerAttachments(key: string, files: StagedComposerAttachment[]): void {
  if (!key || !files.length) return;
  staged.set(key, [...(staged.get(key) ?? []), ...files]);
}

export function takeComposerAttachments(key: string): StagedComposerAttachment[] {
  if (!key) return [];
  const out = staged.get(key) ?? [];
  staged.delete(key);
  return out;
}
