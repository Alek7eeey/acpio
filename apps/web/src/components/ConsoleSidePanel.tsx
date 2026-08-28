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

import "@xterm/xterm/css/xterm.css";



import { useT } from "../lib/i18n";

import { isSidePanelResizeAllowed } from "../lib/panelLayout";

import { api } from "../lib/api";

import {

  acquireConsoleTerminal,

  parkConsoleTerminal,

  mountConsoleTerminal,

  fitConsoleTerminal,

  applyConsoleTerminalTheme,

  readConsoleTerminalIsDark,

  type ConsoleTerminalEntry,

} from "../lib/consoleTerminalCache";

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



function modKeyLabel() {

  if (typeof navigator === "undefined") return "Ctrl";

  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘" : "Ctrl";

}



function syncEntryFromRefs(

  entry: ConsoleTerminalEntry,

  refs: {

    shellAttached: boolean;

    attachPromise: Promise<boolean> | null;

    pendingInput: string;

    lastResize: { cols: number; rows: number };

  },

) {

  entry.shellAttached = refs.shellAttached;

  entry.attachPromise = refs.attachPromise;

  entry.pendingInput = refs.pendingInput;

  entry.lastResize = { ...refs.lastResize };

}



type ContextMenuState = { x: number; y: number };



export function ConsoleSidePanel({

  sessionId,

  open,

  onClose,

  variant = "side",

  cwd,

}: {

  sessionId: string;

  open: boolean;

  onClose?: () => void;

  variant?: "side" | "inline";

  cwd?: string | null;

}) {

  const isInline = variant === "inline";

  const panelOpen = isInline || open;

  const terminalBgVar = isInline ? "--surface" : "--bg";

  const t = useT();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);



  const entryRef = useRef<ConsoleTerminalEntry | null>(null);

  const shellAttachedRef = useRef(false);

  const attachPromiseRef = useRef<Promise<boolean> | null>(null);

  const pendingInputRef = useRef("");



  const [width, setWidth] = useState(readStoredWidth);

  const [dragging, setDragging] = useState(false);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);

  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);

  const lastResizeRef = useRef({ cols: 0, rows: 0 });

  const sessionIdRef = useRef(sessionId);

  sessionIdRef.current = sessionId;

  const openRef = useRef(panelOpen);

  openRef.current = panelOpen;

  const hiddenOutputRef = useRef("");

  const frameOutputRef = useRef("");

  const outputRafRef = useRef(0);

  const resizeRafRef = useRef(0);

  const syncTerminalSizeRef = useRef<(force?: boolean) => ReturnType<typeof fitConsoleTerminal>>(() => null);

  const focusTimersRef = useRef<number[]>([]);



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



  const clearFocusTimers = useCallback(() => {

    for (const id of focusTimersRef.current) window.clearTimeout(id);

    focusTimersRef.current = [];

  }, []);



  const focusTerminal = useCallback(() => {

    if (!openRef.current) return;

    const term = termRef.current;

    if (!term) return;

    try {

      term.focus();

    } catch {

      /* xterm not ready */

    }

  }, []);



  const scheduleTerminalFocus = useCallback(() => {

    clearFocusTimers();

    focusTerminal();

    const raf = window.requestAnimationFrame(() => focusTerminal());

    focusTimersRef.current.push(

      window.setTimeout(focusTerminal, 0),

      window.setTimeout(focusTerminal, 50),

      window.setTimeout(focusTerminal, 160),

    );

    void raf;

  }, [clearFocusTimers, focusTerminal]);



  useEffect(() => {

    const root = document.documentElement;

    let lastThemeDark = readConsoleTerminalIsDark();

    const sync = () => {

      const entry = entryRef.current;

      if (!entry) return;

      const isDark = readConsoleTerminalIsDark();

      if (isDark === lastThemeDark) return;

      lastThemeDark = isDark;

      applyConsoleTerminalTheme(entry, isDark, terminalBgVar);

    };

    const obs = new MutationObserver(sync);

    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    return () => obs.disconnect();

  }, [sessionId, terminalBgVar]);



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

    sendWsMessage({ type: "process.input", sessionId: sessionIdRef.current, data: pending });

  }, []);



  const sendShellResize = useCallback((cols: number, rows: number) => {
    if (!shellAttachedRef.current) return;
    const c = Math.max(1, Math.round(cols));
    const r = Math.max(1, Math.round(rows));
    const prev = lastResizeRef.current;
    if (prev.cols === c && prev.rows === r) return;
    lastResizeRef.current = { cols: c, rows: r };
    sendWsMessage({ type: "process.resize", sessionId: sessionIdRef.current, cols: c, rows: r });
  }, []);

  const syncTerminalSize = useCallback(
    (force = false) => {
      const entry = entryRef.current;
      const term = termRef.current;
      if (!entry || !term) return null;
      if (force) lastResizeRef.current = { cols: 0, rows: 0 };
      const dims = fitConsoleTerminal(entry, force);
      if (!dims) return null;
      sendShellResize(dims.cols, dims.rows);
      return dims;
    },
    [sendShellResize],
  );



  const ensureShellAttached = useCallback((): Promise<boolean> => {

    if (shellAttachedRef.current) return Promise.resolve(true);

    if (attachPromiseRef.current) return attachPromiseRef.current;

    const initialSize = (() => {
      const entry = entryRef.current;
      if (!entry) return undefined;
      const dims = fitConsoleTerminal(entry, true);
      if (!dims || dims.cols < 1 || dims.rows < 1) return undefined;
      return dims;
    })();

    attachPromiseRef.current = api

      .attachConsole(sessionIdRef.current, initialSize)

      .then(() => {

        shellAttachedRef.current = true;

        syncTerminalSize(true);

        requestAnimationFrame(() => syncTerminalSizeRef.current(true));

        flushPendingInput();

        return true;

      })

      .catch(() => false)

      .finally(() => {

        attachPromiseRef.current = null;

      });

    return attachPromiseRef.current;

  }, [flushPendingInput, syncTerminalSize]);



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

    sendWsMessage({ type: "process.clear", sessionId: sessionIdRef.current });

    setContextMenu(null);

    void ensureShellAttached().then((ok) => {

      if (!ok) return;

      scheduleTerminalFocus();

    });

  }, [ensureShellAttached, scheduleTerminalFocus]);



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

  syncTerminalSizeRef.current = syncTerminalSize;

  const scheduleTerminalFocusRef = useRef(scheduleTerminalFocus);

  scheduleTerminalFocusRef.current = scheduleTerminalFocus;



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

        syncTerminalSizeRef.current(true);

        if (openRef.current) scheduleTerminalFocusRef.current();

      });

    });

  }, [queueShellOutput, resetOutputBuffers, sessionId]);



  useEffect(() => {

    if (!panelOpen || !containerRef.current) return;

    syncTerminalSize();

    flushHiddenOutput();

    scheduleTerminalFocus();

    return () => clearFocusTimers();

  }, [clearFocusTimers, flushHiddenOutput, panelOpen, scheduleTerminalFocus, syncTerminalSize]);



  useEffect(() => {

    const container = containerRef.current;

    if (!container) return;



    const entry = acquireConsoleTerminal(sessionId);

    entryRef.current = entry;

    applyConsoleTerminalTheme(entry, readConsoleTerminalIsDark(), terminalBgVar);

    mountConsoleTerminal(entry, container);



    termRef.current = entry.term;

    fitRef.current = entry.fit;

    shellAttachedRef.current = entry.shellAttached;

    attachPromiseRef.current = entry.attachPromise;

    pendingInputRef.current = entry.pendingInput;

    lastResizeRef.current = { ...entry.lastResize };



    const term = entry.term;



    if (!entry.handlersAttached) {

      entry.handlersAttached = true;



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



      entry.disposables.push(dataDisposable, resizeDisposable);

    }



      void ensureShellAttachedRef.current().then((ok) => {

      if (!ok) return;

      syncTerminalSizeRef.current(true);

      if (openRef.current) scheduleTerminalFocusRef.current();

    });



    if (openRef.current) scheduleTerminalFocusRef.current();



    let lastObservedWidth = 0;

    let lastObservedHeight = 0;

    const ro = new ResizeObserver((entries) => {

      const rect = entries[0]?.contentRect;

      if (!rect) return;

      if (

        Math.abs(rect.width - lastObservedWidth) < 1 &&

        Math.abs(rect.height - lastObservedHeight) < 1

      ) {

        return;

      }

      lastObservedWidth = rect.width;

      lastObservedHeight = rect.height;

      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);

      resizeRafRef.current = requestAnimationFrame(() => {

        resizeRafRef.current = 0;

        syncTerminalSizeRef.current();

      });

    });

    ro.observe(container);



    return () => {

      clearFocusTimers();

      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);

      resetOutputBuffers();

      ro.disconnect();

      syncEntryFromRefs(entry, {

        shellAttached: shellAttachedRef.current,

        attachPromise: attachPromiseRef.current,

        pendingInput: pendingInputRef.current,

        lastResize: lastResizeRef.current,

      });

      parkConsoleTerminal(entry, container);

      entryRef.current = null;

      termRef.current = null;

      fitRef.current = null;

    };

  }, [clearFocusTimers, resetOutputBuffers, sessionId, terminalBgVar]);



  return (

    <>

      <aside

        className={`${styles.panel} ${styles.panelTerminal} ${isInline ? styles.panelInline : ""} ${

          dragging ? styles.resizing : ""

        } ${!panelOpen ? styles.panelHidden : ""}`}

        aria-label={t("console.title")}

        aria-hidden={!panelOpen}

        hidden={!panelOpen}

        style={isInline ? undefined : ({ ["--console-panel-width"]: `${width}px` } as CSSProperties)}

      >

        {!isInline ? (

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

        ) : null}

        {!isInline && onClose ? (
          <button
            type="button"
            className={styles.sideCloseBtn}
            onClick={onClose}
            aria-label={t("console.close")}
            title={t("console.close")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}

        <div

          ref={containerRef}

          className={styles.terminal}

          onContextMenu={onTerminalContextMenu}

          onMouseDown={() => scheduleTerminalFocus()}

        />

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


