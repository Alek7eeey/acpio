import type { ChatTreeElementId } from "@acprocess/shared";

const CHAT_TREE_STORAGE_ORDER: ChatTreeElementId[] = [
  "search",
  "searchMsgs",
  "pin",
  "archive",
  "more",
];

/** Optional tree controls shown in settings UI (search is a single toggle). */
export const CHAT_TREE_UI_ORDER: ChatTreeElementId[] = ["search", "pin", "archive", "more"];

export function isChatSearchEnabled(elements: ChatTreeElementId[] | undefined): boolean {
  const list = elements ?? [];
  return list.includes("search") || list.includes("searchMsgs");
}

/** Toggle unified chat search (chats + messages) in stored settings. */
export function toggleChatSearch(elements: ChatTreeElementId[]): ChatTreeElementId[] {
  const on = isChatSearchEnabled(elements);
  if (on) {
    return CHAT_TREE_STORAGE_ORDER.filter(
      (id) => elements.includes(id) && id !== "search" && id !== "searchMsgs",
    );
  }
  const next = new Set([...elements, "search", "searchMsgs"]);
  return CHAT_TREE_STORAGE_ORDER.filter((id) => next.has(id));
}

export function toggleChatTreeElement(
  elements: ChatTreeElementId[],
  id: ChatTreeElementId,
): ChatTreeElementId[] {
  if (id === "search" || id === "searchMsgs") return toggleChatSearch(elements);
  const next = elements.includes(id)
    ? elements.filter((v) => v !== id)
    : [...elements, id];
  return CHAT_TREE_STORAGE_ORDER.filter((v) => next.includes(v));
}
