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
import { isSidePanelResizeAllowed } from "../lib/panelLayout";
import { api } from "../lib/api";
import { subscribeShellConsole } from "../lib/shellConsole";
import { sendWsMessage } from "../lib/useSessionSocket";

import styles from "./ConsoleSidePanel.module.css";

const WIDTH_KEY = "acpio.consolePanelWidth.v1";
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
}: {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [isDark, setIsDark] = useState(readIsDark);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const shellAttachedRef = useRef(false);
  const attachPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingInputRef = useRef("");

  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastResizeRef = useRef({ cols: 0, rows: 0 });
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const openRef = useRef(open);
  openRef.current = open;
  const hiddenOutputRef = useRef("");
  const frameOutputRef = useRef("");
  const outputRafRef = useRef(0);
  const resizeRafRef = useRef(0);

  const mod = modKeyLabel();

  const flushFrameOutput = useCallback(() => {
    outputRafRef.current = 0;
    const term = termRef.current;
    const chunk = frameOutputRef.current;
    frameOutputRef.current = "";
    if (!term || !chunk) return;
    term.write(chunk);
  }, []);

  const queueShellOutput = useCallback(
    (text: string) => {
      if (!text) return;
      if (!openRef.current) {
        hiddenOutputRef.current += text;
        return;
      }
      frameOutputRef.current += text;
      if (!outputRafRef.current) {
        outputRafRef.current = requestAnimationFrame(flushFrameOutput);
      }
    },
    [flushFrameOutput],
  );

  const flushHiddenOutput = useCallback(() => {
    const term = termRef.current;
    const hidden = hiddenOutputRef.current;
    hiddenOutputRef.current = "";
    if (!term || !hidden) return;
    term.write(hidden);
  }, []);

  const resetOutputBuffers = useCallback(() => {
    hiddenOutputRef.current = "";
    frameOutputRef.current = "";
    if (outputRafRef.current) {
      cancelAnimationFrame(outputRafRef.current);
      outputRafRef.current = 0;
    }
  }, []);

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
      if (!isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (!isSidePanelResizeAllowed()) return;
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

  const sendShellResize = useCallback((cols: number, rows: number) => {
    if (!shellAttachedRef.current) return;
    const prev = lastResizeRef.current;
    if (prev.cols === cols && prev.rows === rows) return;
    lastResizeRef.current = { cols, rows };
    sendWsMessage({ type: "process.resize", sessionId: sessionIdRef.current, cols, rows });
  }, []);

  const ensureShellAttached = useCallback((): Promise<boolean> => {
    if (shellAttachedRef.current) return Promise.resolve(true);
    if (attachPromiseRef.current) return attachPromiseRef.current;
    attachPromiseRef.current = api
      .attachConsole(sessionId)
      .then(() => {
        shellAttachedRef.current = true;
        const term = termRef.current;
        if (term) {
          try {
            fitRef.current?.fit();
          } catch {
            /* xterm not ready */
          }
          sendShellResize(term.cols, term.rows);
        }
        flushPendingInput();
        return true;
      })
      .catch(() => false)
      .finally(() => {
        attachPromiseRef.current = null;
      });
    return attachPromiseRef.current;
  }, [sessionId, flushPendingInput, sendShellResize]);

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
    if (!term) return;
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
    termRef.current?.reset();
    shellAttachedRef.current = false;
    attachPromiseRef.current = null;
    pendingInputRef.current = "";
    lastResizeRef.current = { cols: 0, rows: 0 };
    sendWsMessage({ type: "process.clear", sessionId });
    setContextMenu(null);
    void ensureShellAttached().then((ok) => {
      if (!ok) return;
      termRef.current?.focus();
    });
  }, [sessionId, ensureShellAttached]);

  const ensureShellAttachedRef = useRef(ensureShellAttached);
  ensureShellAttachedRef.current = ensureShellAttached;
  const copySelectionRef = useRef(copySelection);
  copySelectionRef.current = copySelection;
  const pasteFromClipboardRef = useRef(pasteFromClipboard);
  pasteFromClipboardRef.current = pasteFromClipboard;
  const clearConsoleRef = useRef(clearConsole);
  clearConsoleRef.current = clearConsole;
  const sendShellResizeRef = useRef(sendShellResize);
  sendShellResizeRef.current = sendShellResize;

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
    return subscribeShellConsole((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      const term = termRef.current;
      if (!term) return;
      if (event.type === "output") {
        queueShellOutput(event.text);
        return;
      }
      resetOutputBuffers();
      term.reset();
      shellAttachedRef.current = false;
      attachPromiseRef.current = null;
      lastResizeRef.current = { cols: 0, rows: 0 };
      void ensureShellAttachedRef.current().then((ok) => {
        if (!ok) return;
        try {
          fitRef.current?.fit();
          sendShellResizeRef.current(term.cols, term.rows);
        } catch {
          /* xterm not ready */
        }
      });
    });
  }, [queueShellOutput, resetOutputBuffers, sessionId]);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* xterm not ready */
    }
    flushHiddenOutput();
    const term = termRef.current;
    if (term && shellAttachedRef.current) {
      sendShellResize(term.cols, term.rows);
    }
  }, [flushHiddenOutput, open, sendShellResize]);

  useEffect(() => {
    if (!containerRef.current) return;

    const activeSessionId = sessionId;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      smoothScrollDuration: 0,
      theme: readXtermTheme(isDark),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;
    lastResizeRef.current = { cols: 0, rows: 0 };
    shellAttachedRef.current = false;
    attachPromiseRef.current = null;
    pendingInputRef.current = "";
    resetOutputBuffers();

    void ensureShellAttachedRef.current().then((ok) => {
      if (!ok) return;
      try {
        fit.fit();
        sendShellResizeRef.current(term.cols, term.rows);
      } catch {
        /* xterm not ready */
      }
    });

    const dataDisposable = term.onData((data) => {
      if (!shellAttachedRef.current) {
        pendingInputRef.current += data;
        void ensureShellAttachedRef.current();
        return;
      }
      sendWsMessage({ type: "process.input", sessionId: sessionIdRef.current, data });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendShellResizeRef.current(cols, rows);
    });

    term.attachCustomKeyEventHandler((e) => {
      const modKey = e.ctrlKey || e.metaKey;
      if (!modKey || e.altKey) return true;

      const key = e.key.toLowerCase();
      if (key === "c") {
        const selection = term.getSelection();
        if (selection && e.type === "keydown") {
          void copySelectionRef.current();
          return false;
        }
        return true;
      }
      if (key === "v" && e.type === "keydown") {
        void pasteFromClipboardRef.current();
        return false;
      }
      if (key === "a" && e.type === "keydown") {
        term.selectAll();
        return false;
      }
      if (key === "l" && e.shiftKey && e.type === "keydown") {
        clearConsoleRef.current();
        return false;
      }
      return true;
    });

    term.focus();

    const ro = new ResizeObserver(() => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        try {
          fit.fit();
          sendShellResizeRef.current(term.cols, term.rows);
        } catch {
          /* xterm not ready */
        }
      });
    });
    ro.observe(containerRef.current);

    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      resetOutputBuffers();
      ro.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      shellAttachedRef.current = false;
      attachPromiseRef.current = null;
      pendingInputRef.current = "";
      void api.detachConsole(activeSessionId).catch(() => {});
    };
  }, [resetOutputBuffers, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = readXtermTheme(isDark);
  }, [isDark]);

  return (
    <>
      <aside
        className={`${styles.panel} ${dragging ? styles.resizing : ""} ${!open ? styles.panelHidden : ""}`}
        aria-label={t("console.title")}
        aria-hidden={!open}
        hidden={!open}
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
