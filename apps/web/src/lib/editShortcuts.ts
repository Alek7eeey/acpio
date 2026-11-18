/**
 * Shortcut labels of the editing rows a text field's menu offers — the chat's
 * composer and the board's task form read the same four commands, so they read
 * them off the same table (`⌘`/`Ctrl` follows the platform the UI runs on).
 */
export function isAppleUi(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function composerEditShortcuts(apple = isAppleUi()) {
  return {
    paste: apple ? "\u2318V" : "Ctrl+V",
    selectAll: apple ? "\u2318A" : "Ctrl+A",
    undo: apple ? "\u2318Z" : "Ctrl+Z",
    redo: apple ? "\u2318\u21e7Z" : "Ctrl+Shift+Z",
  } as const;
}
