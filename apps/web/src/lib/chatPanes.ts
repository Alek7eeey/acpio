export const CHAT_PANES_KEY = "acprocess.chatPanes.v1";
export const CHAT_PANE_MAX = 2;
export const CHAT_SPLIT_MIN_PX = 900;

export type ChatPaneSlot = string | null;

/** Stable fallback when the store has not hydrated pane fields yet (HMR). */
export const FALLBACK_CHAT_PANES: ChatPaneSlot[] = [null];

export type StoredChatPanes = {
  ids: ChatPaneSlot[];
  focus: number;
};

export function isDesktopChatSplit() {
  return typeof window !== "undefined" && window.innerWidth >= CHAT_SPLIT_MIN_PX;
}

/** Setting defaults on; only desktop width actually shows the split. */
export function chatSplitAllowed(enabled?: boolean) {
  return enabled !== false && isDesktopChatSplit();
}

export function readStoredChatPanes(): StoredChatPanes | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CHAT_PANES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredChatPanes;
    if (!Array.isArray(parsed.ids) || parsed.ids.length < 1) return null;
    const ids = parsed.ids.slice(0, CHAT_PANE_MAX).map((id) =>
      typeof id === "string" && id ? id : null,
    );
    while (ids.length < 1) ids.push(null);
    const focus = Math.max(0, Math.min(ids.length - 1, Number(parsed.focus) || 0));
    return { ids, focus };
  } catch {
    return null;
  }
}

export function writeStoredChatPanes(ids: ChatPaneSlot[], focus: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      CHAT_PANES_KEY,
      JSON.stringify({
        ids: ids.slice(0, CHAT_PANE_MAX),
        focus: Math.max(0, Math.min(ids.length - 1, focus)),
      } satisfies StoredChatPanes),
    );
  } catch {
    // ignore quota / private mode
  }
}

export function sanitizeChatPanes(
  ids: ChatPaneSlot[],
  knownIds: Set<string>,
  fallback: string | null,
): ChatPaneSlot[] {
  const next = ids
    .slice(0, CHAT_PANE_MAX)
    .map((id) => (id && knownIds.has(id) ? id : null));
  if (!next.length) return [fallback];
  if (next.every((id) => !id) && fallback) next[0] = fallback;
  return next;
}
