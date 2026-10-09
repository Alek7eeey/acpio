import { useSyncExternalStore } from "react";

/**
 * The board's "Start immediately" switches — the creation composer and the
 * agent picker menu — express what the user picked, so a page reload must not
 * undo it. Mirrors `wrapLines.ts`: a module store read once at import and
 * written on every flip, shared by every mount of the board.
 */
export type AutoStartSlot = "create" | "menu";

const KEYS: Record<AutoStartSlot, string> = {
  create: "acpio.boardCreateAutoStart.v1",
  menu: "acpio.boardMenuAutoStart.v1",
};

/** Creation waits for the user; the agent menu starts the run. */
const DEFAULTS: Record<AutoStartSlot, boolean> = { create: false, menu: true };

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(slot: AutoStartSlot): boolean {
  try {
    const raw = storage()?.getItem(KEYS[slot]);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* ignore */
  }
  return DEFAULTS[slot];
}

const values: Record<AutoStartSlot, boolean> = {
  create: read("create"),
  menu: read("menu"),
};
const listeners = new Set<() => void>();

export function toggleBoardAutoStart(slot: AutoStartSlot): void {
  values[slot] = !values[slot];
  try {
    storage()?.setItem(KEYS[slot], values[slot] ? "1" : "0");
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoardAutoStart(slot: AutoStartSlot): boolean {
  return useSyncExternalStore(subscribe, () => values[slot], () => values[slot]);
}
