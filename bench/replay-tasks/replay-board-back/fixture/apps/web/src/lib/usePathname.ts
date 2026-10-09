import { useMemo, useSyncExternalStore } from "react";

type HistoryFn = History["pushState"];

let pushStatePatched = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function ensureHistoryPatched() {
  if (pushStatePatched || typeof window === "undefined") return;
  pushStatePatched = true;

  const origPush = history.pushState.bind(history) as HistoryFn;
  const origReplace = history.replaceState.bind(history) as HistoryFn;

  history.pushState = (...args) => {
    origPush(...args);
    notify();
  };
  history.replaceState = (...args) => {
    origReplace(...args);
    notify();
  };
  window.addEventListener("popstate", notify);
}

function subscribe(listener: () => void) {
  ensureHistoryPatched();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLocationKey() {
  return window.location.pathname + window.location.search;
}

/** Browser location synced with history.pushState/replaceState. */
export function useBrowserLocation() {
  const key = useSyncExternalStore(subscribe, getLocationKey, () => "/");
  return useMemo(() => {
    const q = key.indexOf("?");
    if (q === -1) return { pathname: key || "/", search: "" };
    return {
      pathname: key.slice(0, q) || "/",
      search: key.slice(q),
    };
  }, [key]);
}

export function usePathname() {
  return useBrowserLocation().pathname;
}
