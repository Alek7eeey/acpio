import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { clampConsoleTerminalSize } from "@acpio/shared";

import { api } from "./api";

export const CONSOLE_TERMINAL_THEME_DARK = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(255, 255, 255, 0.28)",
  selectionForeground: "#ffffff",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
} as const;

export const CONSOLE_TERMINAL_THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#0c0c0c",
  cursor: "#0c0c0c",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(12, 12, 12, 0.25)",
  selectionForeground: "#0c0c0c",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
} as const;

export function readConsoleTerminalIsDark() {
  if (typeof document === "undefined") return true;
  return document.documentElement.getAttribute("data-theme") !== "light";
}

function readCssColor(varName: "--bg" | "--surface") {
  if (typeof document === "undefined") {
    return readConsoleTerminalIsDark()
      ? varName === "--surface"
        ? "#171a21"
        : "#0f1115"
      : varName === "--surface"
        ? "#ffffff"
        : "#f7f8fa";
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (value) return value;
  return readConsoleTerminalIsDark()
    ? varName === "--surface"
      ? "#171a21"
      : "#0f1115"
    : varName === "--surface"
      ? "#ffffff"
      : "#f7f8fa";
}

export function readConsoleTerminalTheme(
  isDark = readConsoleTerminalIsDark(),
  backgroundVar: "--bg" | "--surface" = "--bg",
) {
  const surface = readCssColor(backgroundVar);
  const palette = isDark ? CONSOLE_TERMINAL_THEME_DARK : CONSOLE_TERMINAL_THEME_LIGHT;
  return { ...palette, background: surface, cursorAccent: surface };
}

export function applyConsoleTerminalTheme(
  entry: ConsoleTerminalEntry,
  isDark = readConsoleTerminalIsDark(),
  backgroundVar: "--bg" | "--surface" = "--bg",
) {
  entry.term.options.theme = readConsoleTerminalTheme(isDark, backgroundVar);
}

export type ConsoleTerminalEntry = {
  sessionId: string;
  park: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  shellAttached: boolean;
  attachPromise: Promise<boolean> | null;
  pendingInput: string;
  lastResize: { cols: number; rows: number };
  lastFitSize: { width: number; height: number; cols: number; rows: number } | null;
  mountCount: number;
  handlersAttached: boolean;
  disposables: Array<{ dispose: () => void }>;
};

const cache = new Map<string, ConsoleTerminalEntry>();
let parkRoot: HTMLDivElement | null = null;

function getParkRoot(): HTMLDivElement {
  if (!parkRoot) {
    parkRoot = document.createElement("div");
    parkRoot.style.cssText =
      "position:fixed;left:-10000px;top:0;width:800px;height:600px;overflow:hidden;pointer-events:none;visibility:hidden";
    const host = document.body ?? document.documentElement;
    host.appendChild(parkRoot);
  }
  return parkRoot;
}

function moveTerminalDom(from: HTMLElement, to: HTMLElement) {
  while (from.firstChild) {
    to.appendChild(from.firstChild);
  }
}

function readFitHost(term: Terminal): HTMLElement | null {
  const host = term.element?.parentElement;
  return host instanceof HTMLElement ? host : null;
}

function createEntry(sessionId: string): ConsoleTerminalEntry {
  const park = document.createElement("div");
  park.style.width = "100%";
  park.style.height = "100%";
  getParkRoot().appendChild(park);

  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily:
      '"CaskaydiaCove Nerd Font Mono", "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1,
    letterSpacing: 0,
    scrollback: 5000,
    smoothScrollDuration: 0,
    customGlyphs: false,
    theme: readConsoleTerminalTheme(),
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(park);

  return {
    sessionId,
    park,
    term,
    fit,
    shellAttached: false,
    attachPromise: null,
    pendingInput: "",
    lastResize: { cols: 0, rows: 0 },
    lastFitSize: null,
    mountCount: 0,
    handlersAttached: false,
    disposables: [],
  };
}

export function getConsoleTerminal(sessionId: string): ConsoleTerminalEntry | undefined {
  return cache.get(sessionId);
}

export function acquireConsoleTerminal(sessionId: string): ConsoleTerminalEntry {
  let entry = cache.get(sessionId);
  if (!entry) {
    entry = createEntry(sessionId);
    cache.set(sessionId, entry);
  }
  entry.mountCount++;
  return entry;
}

export function mountConsoleTerminal(entry: ConsoleTerminalEntry, container: HTMLElement) {
  moveTerminalDom(entry.park, container);
  entry.lastFitSize = null;
  const runFit = () => {
    entry.lastFitSize = null;
    fitConsoleTerminal(entry, true);
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(runFit);
  });
  if (typeof document !== "undefined" && document.fonts?.ready) {
    void document.fonts.ready.then(runFit);
  }
}

export function fitConsoleTerminal(
  entry: ConsoleTerminalEntry,
  force = false,
): { cols: number; rows: number } | null {
  try {
    const { term, fit } = entry;
    const host = readFitHost(term);
    if (!host) return null;

    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width < 1 || height < 1) return null;

    const last = entry.lastFitSize;
    if (
      !force &&
      last &&
      last.width === width &&
      last.height === height &&
      term.cols > 0 &&
      term.rows > 0
    ) {
      return { cols: term.cols, rows: term.rows };
    }

    const prevCols = term.cols;
    const prevRows = term.rows;

    fit.fit();

    const next = clampConsoleTerminalSize({ cols: term.cols, rows: term.rows });
    if (next.cols !== term.cols || next.rows !== term.rows) {
      term.resize(next.cols, next.rows);
    }

    if ((term.cols !== prevCols || term.rows !== prevRows) && term.rows > 0) {
      term.refresh(0, term.rows - 1);
    }

    entry.lastFitSize = { width, height, cols: term.cols, rows: term.rows };
    return { cols: term.cols, rows: term.rows };
  } catch {
    return null;
  }
}

export function parkConsoleTerminal(entry: ConsoleTerminalEntry, container: HTMLElement) {
  moveTerminalDom(container, entry.park);
  entry.mountCount = Math.max(0, entry.mountCount - 1);
}

export async function destroyConsoleTerminal(sessionId: string): Promise<void> {
  const entry = cache.get(sessionId);
  if (!entry) return;
  for (const disposable of entry.disposables) {
    try {
      disposable.dispose();
    } catch {
      /* ignore */
    }
  }
  entry.disposables.length = 0;
  entry.term.dispose();
  entry.park.remove();
  cache.delete(sessionId);
  await api.detachConsole(sessionId).catch(() => {});
}
