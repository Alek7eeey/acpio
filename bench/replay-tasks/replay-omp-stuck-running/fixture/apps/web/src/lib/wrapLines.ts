import { useSyncExternalStore } from "react";

/**
 * Long-line wrapping for code blocks and diffs, kept in one place on purpose:
 * the setting is a reading preference, so toggling it in one block (or in the
 * fullscreen diff) must not be undone by the next viewer.
 */
const STORAGE_KEY = "acpio.wrapLines.v1";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): boolean {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

let wrap = readStored();
const listeners = new Set<() => void>();

export function toggleWrapLines(): void {
  wrap = !wrap;
  try {
    storage()?.setItem(STORAGE_KEY, wrap ? "1" : "0");
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

export function useWrapLines(): boolean {
  return useSyncExternalStore(subscribe, () => wrap, () => wrap);
}
