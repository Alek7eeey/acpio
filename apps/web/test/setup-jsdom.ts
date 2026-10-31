// jsdom gives the tests a window whose localStorage the web app reads through
// the bare global — but Node 22+ carries a `localStorage` global of its own,
// undefined until the process is started with --localstorage-file. Vitest's
// jsdom environment only copies the window's keys that the global does not
// already have, so on such a Node the tests keep the undefined one, and any
// module that reads the storage at import time dies (`Cannot read properties of
// undefined (reading 'getItem')`).
//
// Point the global at the storage of the jsdom instance the environment left on
// `globalThis.jsdom` (the window itself is not reachable — vitest makes the
// global its own window). On a Node without that global (20, 22, 24) vitest
// already copied the window's own, so this is a no-op there: the same suite runs
// green on every version the pipeline and a laptop may use.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom && (globalThis as { localStorage?: unknown }).localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    get: () => dom.window.localStorage,
    configurable: true,
  });
}
