import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { sendWsMessage } from "../lib/useSessionSocket";
import { useAppStore } from "../lib/store";

import styles from "./ConsoleSidePanel.module.css";

const WIDTH_KEY = "acprocess.consolePanelWidth.v1";
const WIDTH_MIN = 280;
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 380;

function readStoredWidth() {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

function readIsDark() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function readXtermTheme(isDark: boolean) {
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: pick("--surface", isDark ? "#0f172a" : "#ffffff"),
    foreground: pick("--text", isDark ? "#e2e8f0" : "#1e293b"),
    cursor: pick("--accent", isDark ? "#818cf8" : "#4f46e5"),
    selectionBackground: isDark ? "rgba(51, 65, 85, 0.65)" : "rgba(148, 163, 184, 0.45)",
    selectionForeground: pick("--text", isDark ? "#f8fafc" : "#0f172a"),
  };
}

function modKeyLabel() {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘" : "Ctrl";
}

type ContextMenuState = { x: number; y: number };

export function ConsoleSidePanel({
  sessionId,
  open,
  onClose,
  live,
}: {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  live?: boolean;
}) {
  const t = useT();
  const clearConsoleForSession = useAppStore((s) => s.clearConsoleForSession);
  const output = useAppStore((s) => s.consoleOutput[sessionId] ?? "");
  const lastSource = useAppStore((s) => s.consoleLastSource[sessionId] ?? "agent");

  const [isDark, setIsDark] = useState(readIsDark);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const shellAttachedRef = useRef(false);
  const attachPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingInputRef = useRef("");
  const inputLockedRef = useRef(false);
  const unlockTimerRef = useRef<number | null>(null);

  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const prevSessionRef = useRef(sessionId);
  const outputRef = useRef(output);
  outputRef.current = output;

  const mod = modKeyLabel();

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setIsDark(readIsDark());
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (window.innerWidth < 900) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (window.innerWidth < 900) return;
    setWidth(WIDTH_DEFAULT);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const max = Math.min(WIDTH_MAX, Math.floor(window.innerWidth * 0.55));
      const next = drag.startWidth - (e.clientX - drag.startX);
      setWidth(Math.min(max, Math.max(WIDTH_MIN, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  const flushPendingInput = useCallback(() => {
    const pending = pendingInputRef.current;
    if (!pending || !shellAttachedRef.current) return;
    pendingInputRef.current = "";
    sendWsMessage({ type: "process.input", sessionId, data: pending });
  }, [sessionId]);

  const ensureShellAttached = useCallback((): Promise<boolean> => {
    if (shellAttachedRef.current) return Promise.resolve(true);
    if (attachPromiseRef.current) return attachPromiseRef.current;
    attachPromiseRef.current = api
      .attachConsole(sessionId)
      .then(() => {
        shellAttachedRef.current = true;
        flushPendingInput();
        return true;
      })
      .catch(() => false)
      .finally(() => {
        attachPromiseRef.current = null;
      });
    return attachPromiseRef.current;
  }, [sessionId, flushPendingInput]);

  const resetTerminalView = useCallback((term: Terminal) => {
    term.reset();
    writtenRef.current = 0;
    inputLockedRef.current = false;
    term.options.disableStdin = false;
  }, []);

  const tryUnlockShell = useCallback((chunk: string) => {
    if (!inputLockedRef.current || !shellAttachedRef.current) return;
    if (!/(?:\r?\n|^)[^\r\n]*>\s*$/.test(chunk) && !/\$\s*$/.test(chunk)) return;
    if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
    unlockTimerRef.current = window.setTimeout(() => {
      inputLockedRef.current = false;
      const term = termRef.current;
      if (term) {
        term.options.disableStdin = false;
        term.focus();
      }
      unlockTimerRef.current = null;
    }, 60);
  }, []);

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = term.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    const term = termRef.current;
    if (!term || inputLockedRef.current) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    await ensureShellAttached();
    term.paste(text);
  }, [ensureShellAttached]);

  const clearConsole = useCallback(() => {
    const term = termRef.current;
    if (term) resetTerminalView(term);
    clearConsoleForSession(sessionId);
    sendWsMessage({ type: "process.clear", sessionId });
    setContextMenu(null);
    termRef.current?.focus();
  }, [clearConsoleForSession, resetTerminalView, sessionId]);

  const onTerminalContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!open || !containerRef.current) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 8000,
      theme: readXtermTheme(isDark),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = 0;

    const buffered = outputRef.current;
    if (buffered) {
      term.write(buffered);
      writtenRef.current = buffered.length;
    }

    void ensureShellAttached();

    const dataDisposable = term.onData((data) => {
      if (inputLockedRef.current) return;
      if (!shellAttachedRef.current) {
        pendingInputRef.current += data;
        void ensureShellAttached();
        return;
      }
      sendWsMessage({ type: "process.input", sessionId, data });
      if (data.includes("\r") || data.includes("\n")) {
        inputLockedRef.current = true;
        term.options.disableStdin = true;
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendWsMessage({ type: "process.resize", sessionId, cols, rows });
    });

    term.attachCustomKeyEventHandler((e) => {
      const modKey = e.ctrlKey || e.metaKey;
      if (!modKey || e.altKey) return true;

      const key = e.key.toLowerCase();
      if (key === "c") {
        const selection = term.getSelection();
        if (selection && e.type === "keydown") {
          void copySelection();
          return false;
        }
        return true;
      }
      if (key === "v" && e.type === "keydown") {
        void pasteFromClipboard();
        return false;
      }
      if (key === "a" && e.type === "keydown") {
        term.selectAll();
        return false;
      }
      if (key === "l" && e.shiftKey && e.type === "keydown") {
        clearConsole();
        return false;
      }
      return true;
    });

    term.focus();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* xterm not ready */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (unlockTimerRef.current) window.clearTimeout(unlockTimerRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      shellAttachedRef.current = false;
      attachPromiseRef.current = null;
      pendingInputRef.current = "";
    };
  }, [open, sessionId, ensureShellAttached, copySelection, pasteFromClipboard, clearConsole]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = readXtermTheme(isDark);
  }, [isDark]);

  useEffect(() => {
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;
    shellAttachedRef.current = false;
    attachPromiseRef.current = null;
    pendingInputRef.current = "";
    const term = termRef.current;
    if (!term) return;
    resetTerminalView(term);
    void ensureShellAttached();
  }, [sessionId, resetTerminalView, ensureShellAttached]);

  useEffect(() => {
    if (!open) return;
    const term = termRef.current;
    if (!term) return;

    if (output.length < writtenRef.current) {
      resetTerminalView(term);
    }

    const chunk = output.slice(writtenRef.current);
    if (!chunk) return;

    term.write(chunk);
    writtenRef.current = output.length;
    if (lastSource === "shell") tryUnlockShell(chunk);
  }, [output, open, resetTerminalView, lastSource, tryUnlockShell]);

  if (!open) return null;

  return (
    <>
      <aside
        className={`${styles.panel} ${dragging ? styles.resizing : ""}`}
        aria-label={t("console.title")}
        style={{ ["--console-panel-width"]: `${width}px` } as CSSProperties}
      >
        <div
          className={styles.splitter}
          onPointerDown={onSplitterDown}
          onDoubleClick={onSplitterDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizePlan")}
          aria-valuenow={width}
          aria-valuemin={WIDTH_MIN}
          aria-valuemax={WIDTH_MAX}
          title={t("common.resizePlanHint")}
        />
        <div className={styles.header}>
          <div className={styles.headerText}>
            <div className={styles.headerTitles}>
              <span className={styles.eyebrow}>{t("console.title")}</span>
              {live ? <span className={styles.liveBadge}>{t("console.live")}</span> : null}
              <p className={styles.hint}>{t("console.hint")}</p>
            </div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={t("common.cancel")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div ref={containerRef} className={styles.terminal} onContextMenu={onTerminalContextMenu} />
      </aside>

      {contextMenu
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.contextMenu}
              style={{ left: contextMenu.x, top: contextMenu.y }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void copySelection();
                  setContextMenu(null);
                }}
              >
                <span>{t("console.copy")}</span>
                <kbd className={styles.menuShortcut}>{mod}+C</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void pasteFromClipboard();
                  setContextMenu(null);
                }}
              >
                <span>{t("console.paste")}</span>
                <kbd className={styles.menuShortcut}>{mod}+V</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  termRef.current?.selectAll();
                  setContextMenu(null);
                }}
              >
                <span>{t("console.selectAll")}</span>
                <kbd className={styles.menuShortcut}>{mod}+A</kbd>
              </button>
              <div className={styles.contextMenuDivider} aria-hidden />
              <button type="button" role="menuitem" className={styles.menuDanger} onClick={clearConsole}>
                <span>{t("console.clear")}</span>
                <kbd className={styles.menuShortcut}>{mod}+Shift+L</kbd>
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
