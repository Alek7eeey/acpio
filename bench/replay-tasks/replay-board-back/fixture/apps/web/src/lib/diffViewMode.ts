import { useSyncExternalStore } from "react";

/**
 * Unified/split diff mode, kept in one place on purpose: the mode is a reading
 * preference, so toggling it in one diff must not be undone by the next viewer.
 * Mirrors `wrapLines.ts` — a module store, so every mounted viewer (the docked
 * diff, the review stage, a commit diff) reads the same value.
 */
const STORAGE_KEY = "acpio.gitDiffView.v1";

export type DiffViewMode = "unified" | "split";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): DiffViewMode {
  try {
    return storage()?.getItem(STORAGE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

let mode = readStored();
const listeners = new Set<() => void>();

export function setDiffViewMode(next: DiffViewMode): void {
  if (next === mode) return;
  mode = next;
  try {
    storage()?.setItem(STORAGE_KEY, mode);
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

export function useDiffViewMode(): DiffViewMode {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}
