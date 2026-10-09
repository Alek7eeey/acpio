/** Message action hotkeys — physical keys via `KeyboardEvent.code` (RU layout mirrored). */

export type MessageHotAction =
  | "copy"
  | "copySelection"
  | "edit"
  | "like"
  | "dislike"
  | "share"
  | "regenerate"
  | "readAloud";

export type MessageHotkeyTarget = {
  id: string;
  /** True when this message's context menu is open (pins the target). */
  menuOpen: boolean;
  has: (action: MessageHotAction) => boolean;
  run: (action: MessageHotAction) => boolean;
  /** Optional: whether the current DOM selection lives inside this message. */
  selectionInMessage?: () => boolean;
};

const targets = new Map<string, MessageHotkeyTarget>();
/** Active only while the pointer is over a message (or its open context menu). */
let hoverId: string | null = null;
let mediaQuery: MediaQueryList | null = null;

function syncMedia() {
  if (typeof window === "undefined") return null;
  if (!mediaQuery) {
    mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  }
  return mediaQuery;
}

/** Desktop with a fine pointer — show shortcut hints. Touch / coarse → hide. */
export function prefersHotkeyHints(): boolean {
  return syncMedia()?.matches ?? true;
}

export function subscribeHotkeyHintPreference(listener: () => void): () => void {
  const mq = syncMedia();
  if (!mq) return () => {};
  const onChange = () => listener();
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function registerMessageHotkeys(target: MessageHotkeyTarget): () => void {
  targets.set(target.id, target);
  return () => {
    targets.delete(target.id);
    if (hoverId === target.id) hoverId = null;
  };
}

export function updateMessageHotkeys(target: MessageHotkeyTarget): void {
  if (targets.has(target.id)) targets.set(target.id, target);
}

export function setMessageHotkeyHover(id: string | null): void {
  hoverId = id;
}

function menuPinnedTarget(): MessageHotkeyTarget | null {
  for (const t of targets.values()) {
    if (t.menuOpen) return t;
  }
  return null;
}

export function getMessageHotkeyTarget(): MessageHotkeyTarget | null {
  const pinned = menuPinnedTarget();
  if (pinned) return pinned;
  if (hoverId) return targets.get(hoverId) ?? null;
  return null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

/**
 * Map a keydown to a message action using physical key codes so RU/EN layouts
 * hit the same keys (KeyE → edit whether the glyph is E or У, etc.).
 */
export function resolveMessageHotkey(e: KeyboardEvent): MessageHotAction | null {
  if (e.defaultPrevented) return null;
  if (e.repeat) return null;
  if (isTypingTarget(e.target)) return null;

  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === "KeyC") {
    if (e.altKey) return null;
    const target = getMessageHotkeyTarget();
    if (!target) return null;
    if (e.shiftKey) return "copy";
    const sel = (window.getSelection()?.toString() ?? "").trim();
    if (sel) {
      if (target.selectionInMessage?.()) return "copySelection";
      return null;
    }
    return "copy";
  }

  if (mod || e.altKey) return null;

  switch (e.code) {
    case "KeyE":
      return "edit";
    case "KeyL":
      return "like";
    case "KeyD":
      return "dislike";
    case "KeyS":
      return "share";
    case "KeyR":
      return "regenerate";
    case "KeyA":
      return "readAloud";
    default:
      return null;
  }
}

/** Install the global document listener once. Returns unsubscribe. */
export function installMessageHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const action = resolveMessageHotkey(e);
    if (!action) return;
    const target = getMessageHotkeyTarget();
    if (!target?.has(action)) return;
    e.preventDefault();
    e.stopPropagation();
    target.run(action);
  };
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}
