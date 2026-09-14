import { useSyncExternalStore } from "react";

/**
 * How the diff stage lays the changed files out:
 * - `stacked` — every file in one continuous vertical scroll, each file panning
 *   its own long lines sideways (the stage's historical behaviour);
 * - `single` — one file per screen: the file header is fixed and its body owns
 *   both scroll axes, so a wide line pans without dragging a sticky header.
 *
 * Kept in a module store like `wrapLines` / `diffViewMode`: the layout is a
 * reading preference, so toggling it in one stage must not be undone by the
 * next viewer and every mounted stage reads the same value.
 */
const STORAGE_KEY = "acpio.gitDiffLayout.v1";

export type DiffLayout = "stacked" | "single";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): DiffLayout {
  try {
    return storage()?.getItem(STORAGE_KEY) === "single" ? "single" : "stacked";
  } catch {
    return "stacked";
  }
}

let layout = readStored();
const listeners = new Set<() => void>();

export function setDiffLayout(next: DiffLayout): void {
  if (next === layout) return;
  layout = next;
  try {
    storage()?.setItem(STORAGE_KEY, layout);
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

export function useDiffLayout(): DiffLayout {
  return useSyncExternalStore(subscribe, () => layout, () => layout);
}
