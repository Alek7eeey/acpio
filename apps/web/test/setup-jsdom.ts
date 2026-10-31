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
// global its own window). Defined without reading the old one: on a Node whose
// own global is an experimental getter, that read prints "localStorage is not
// available because --localstorage-file was not provided" on every worker, and
// the value it would hand back is the same storage vitest already copied.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  try {
    Object.defineProperty(globalThis, "localStorage", {
      get: () => dom.window.localStorage,
      configurable: true,
    });
  } catch {
    // A non-configurable global stays as Node defined it; jsdom's copy is
    // already there on every Node the suite supports.
  }
}

// jsdom has no canvas, and says so — `Not implemented: HTMLCanvasElement's
// getContext()` — on every call, which xterm makes while feature-detecting in
// its module body. Answer `null` instead: that is exactly what jsdom answers
// after the message, so nothing about the app changes, and a test run stops
// filling its log with a notice about a picture nobody draws.
const canvas = (globalThis as { HTMLCanvasElement?: { prototype: HTMLCanvasElement } })
  .HTMLCanvasElement;
if (canvas) {
  canvas.prototype.getContext = (() => null) as HTMLCanvasElement["getContext"];
}
