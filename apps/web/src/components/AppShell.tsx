import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  BUILD_INFO,
  modelDisplayName,
  modelForProvider,
  type MessageDto,
  type SessionDto,
} from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { useBrowserLocation } from "../lib/usePathname";
import {
  getSettingsTree,
  parseSettingsSearch,
  settingsPath,
  defaultLeafFor,
  type SettingsSection,
  type SettingsLeaf,
} from "../lib/settingsNav";
import { highlightText, matchAny, settingsSearchIndex } from "../lib/settingsSearch";
import { isChatSearchEnabled } from "../lib/chatTreeSearch";
import { ChatSidebar } from "./ChatSidebar";
import { collectRecentCwds, CreateSessionFolderPicker } from "./CreateSessionFolderPicker";
import { harnessShortLabel } from "../lib/harness";
import { normalizeCwd } from "../lib/pathSegments";
import { firstUserTitleLine, truncateSessionTitle } from "../lib/sessionTitle";
import { showToast } from "../lib/toast";
import { HoverTip } from "./HoverTip";
import { InstallAppButton } from "./InstallAppButton";
import { LocaleToggle } from "./LocaleToggle";
import { SearchDialog, type SearchDialogTab } from "./SearchDialog";
import { ThemeToggle } from "./ThemeToggle";
import { ChatPage } from "../pages/ChatPage";
import { SettingsPage } from "../pages/SettingsPage";
import styles from "./AppShell.module.css";

const SIDEBAR_WIDTH_KEY = "acpio.sidebarWidth.v2";
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 1200;
const SIDEBAR_DEFAULT = 360;
const SIDEBAR_COLLAPSE_AT = 240;
/** Keep at least this much room for the chat column. */
const SIDEBAR_VIEWPORT_MARGIN = 320;
/** Mobile bottom-sheet snap heights (viewport fractions). */
const SHEET_SNAPS_CHAT = [0.48, 0.56, 0.64, 0.72, 0.8, 0.88, 0.94] as const;
const SHEET_SNAPS_SETTINGS = [0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9] as const;

function headerFolderLabel(cwd: string | null | undefined) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return "";
  if (normalized.length <= 28) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] || normalized;
  return leaf.length <= 28 ? leaf : `…${leaf.slice(-26)}`;
}

function headerChatTitle(
  session: SessionDto,
  messages: MessageDto[] | undefined,
): string {
  const stored = session.title.trim();
  const fromMsg = firstUserTitleLine(messages);
  if (fromMsg && stored && fromMsg.startsWith(stored) && fromMsg.length > stored.length) {
    return truncateSessionTitle(fromMsg);
  }
  return stored || (fromMsg ? truncateSessionTitle(fromMsg) : "");
}

function readStoredWidth() {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
}

function ShellPage({ pathname }: { pathname: string }) {
  if (pathname === "/" || pathname === "") return <ChatPage />;
  if (pathname.startsWith("/chat")) return <ChatPage />;
  if (pathname.startsWith("/settings")) return <SettingsPage />;
  return <ChatPage />;
}

export function AppShell() {
  const t = useT();
  const { pathname, search } = useBrowserLocation();
  const navigate = useNavigate();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const sessions = useAppStore((s) => s.sessions);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const importHarnessSession = useAppStore((s) => s.importHarnessSession);
  const adapters = useAppStore((s) => s.adapters);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const settings = useAppStore((s) => s.settings);
  const headerHeightPx = settings.chatHeaderHeight ?? 52;
  useEffect(() => {
    document.documentElement.style.setProperty("--header-height", `${headerHeightPx}px`);
  }, [headerHeightPx]);
  const activeSession = useAppStore((s) => s.activeSession);
  const sessionDetails = useAppStore((s) => s.sessionDetails);
  const chatPaneIds = useAppStore((s) => s.chatPaneIds);
  const focusedPaneIndex = useAppStore((s) => s.focusedPaneIndex ?? 0);
  const headerSession = useMemo(() => {
    const focusedId =
      (chatPaneIds?.length ?? 0) > 1
        ? (chatPaneIds?.[focusedPaneIndex] ?? null)
        : (activeSession?.id ?? null);
    if (!focusedId) return activeSession;
    if (activeSession?.id === focusedId) return activeSession;
    return sessions.find((s) => s.id === focusedId) ?? activeSession;
  }, [activeSession, chatPaneIds, focusedPaneIndex, sessions]);
  const headerTitle = useMemo(() => {
    if (!headerSession) return "";
    const detail =
      activeSession?.id === headerSession.id
        ? activeSession
        : sessionDetails[headerSession.id];
    return headerChatTitle(headerSession, detail?.messages);
  }, [activeSession, headerSession, sessionDetails]);
  const settingsTree = useMemo(() => getSettingsTree(t), [t]);
  const settingsQuery = useAppStore((s) => s.settingsQuery);
  const setSettingsQuery = useAppStore((s) => s.setSettingsQuery);
  const searchIndex = useMemo(() => settingsSearchIndex(t), [t]);

  /**
   * Tree view with the active search applied: branches/leaves whose label or
   * search-index terms match; branches auto-expand while searching.
   */
  const settingsTreeView = useMemo(() => {
    const q = settingsQuery.trim();
    if (!q) return { branches: settingsTree, matches: 0 };
    let matches = 0;
    const branches = settingsTree
      .map((branch) => {
        const children = branch.children.filter((leaf) =>
          matchAny([leaf.label, ...(searchIndex[leaf.id] ?? [])], q),
        );
        const branchHits = matchAny([branch.label], q);
        if (children.length === 0 && !branchHits) return null;
        matches += children.length;
        return children.length > 0 ? { ...branch, children } : branch;
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
    return { branches, matches };
  }, [settingsTree, settingsQuery, searchIndex]);

  const harnessIds = adapters.length
    ? adapters.map((a) => a.id)
    : (["cursor", "omp"] as const);
  const onlineHarnessCount = harnessIds.filter((id) => agentAvailability[id] === true).length;
  const harnessTotal = harnessIds.length;

  const agentStatusTitle = useMemo(
    () =>
      t("common.harnessesStatus", {
        online: onlineHarnessCount,
        total: harnessTotal,
      }),
    [onlineHarnessCount, harnessTotal, t],
  );

  // Popover on the header agent chip: hover (desktop) / tap (touch) shows
  // agent name, default model and connection status.
  const [agentTipOpen, setAgentTipOpen] = useState(false);
  const agentChipRef = useRef<HTMLDivElement>(null);
  const agentTipTimer = useRef<number | null>(null);

  const openAgentTip = () => {
    if (agentTipTimer.current) window.clearTimeout(agentTipTimer.current);
    agentTipTimer.current = null;
    setAgentTipOpen(true);
  };
  const closeAgentTip = () => {
    if (agentTipTimer.current) window.clearTimeout(agentTipTimer.current);
    agentTipTimer.current = window.setTimeout(() => setAgentTipOpen(false), 200);
  };

  useEffect(() => {
    if (!agentTipOpen) return;
    const onDocPointerDown = (e: globalThis.PointerEvent) => {
      if (agentChipRef.current && !agentChipRef.current.contains(e.target as Node)) {
        if (agentTipTimer.current) window.clearTimeout(agentTipTimer.current);
        agentTipTimer.current = null;
        setAgentTipOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [agentTipOpen]);

  const isChat = pathname === "/" || pathname.startsWith("/chat");
  const isSettings = pathname.startsWith("/settings");
  const showSidebar = isChat || isSettings;

  const sheetRef = useRef<HTMLElement | null>(null);
  const sheetSnapRef = useRef(2);
  const sheetDragRaf = useRef(0);
  const sheetDragRef = useRef<{
    startY: number;
    lastY: number;
    startH: number;
  } | null>(null);
  const pullerDragRef = useRef<{
    pointerId: number;
    startY: number;
    lastY: number;
    opened: boolean;
  } | null>(null);

  const sheetSnaps = isSettings ? SHEET_SNAPS_SETTINGS : SHEET_SNAPS_CHAT;
  const sheetMinPx = isSettings ? 280 : 360;

  const applySheetSnapCss = useCallback(
    (index: number, snaps: readonly number[] = sheetSnaps) => {
      const el = sheetRef.current;
      if (!el) return;
      const i = Math.max(0, Math.min(snaps.length - 1, index));
      el.style.setProperty("--sheet-h", `${Math.round(snaps[i] * 100)}dvh`);
    },
    [sheetSnaps],
  );

  // Close chat tree when entering settings on mobile (don't auto-open).
  useEffect(() => {
    if (!isSettings) return;
    if (window.innerWidth < 900) setSidebarOpen(false);
  }, [isSettings, setSidebarOpen]);

  const settingsNav = useMemo(() => parseSettingsSearch(search), [search]);
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>({
    agent: true,
  });
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [railRecentsPos, setRailRecentsPos] = useState<{ x: number; y: number } | null>(null);
  const [railFolderPicker, setRailFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [railSettingsMenu, setRailSettingsMenu] = useState<{
    section: SettingsSection;
    x: number;
    y: number;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTab, setSearchTab] = useState<SearchDialogTab>("chats");
  const openSearch = useCallback((tab: SearchDialogTab = "chats") => {
    setSearchTab(tab);
    setSearchOpen(true);
  }, []);
  const searchEnabled = isChatSearchEnabled(settings.chatTreeElements);

  useEffect(() => {
    if (!searchEnabled || searchOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      openSearch("chats");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchEnabled, searchOpen, openSearch]);
  const railRecentsRef = useRef<HTMLDivElement>(null);
  const railSettingsRef = useRef<HTMLDivElement>(null);

  const railMode = showSidebar && !sidebarOpen && settings.sidebarCollapse === "rail";
  // Bounce the app title whenever the tree (sidebar) collapses or expands.
  const [brandBump, setBrandBump] = useState(false);
  const prevSidebarOpen = useRef(sidebarOpen);
  useEffect(() => {
    if (prevSidebarOpen.current === sidebarOpen) return;
    const wasOpen = prevSidebarOpen.current;
    prevSidebarOpen.current = sidebarOpen;
    if (sidebarOpen && !wasOpen) {
      setBrandBump(true);
      const id = window.setTimeout(() => setBrandBump(false), 460);
      requestAnimationFrame(() => applySheetSnapCss(sheetSnapRef.current));
      return () => window.clearTimeout(id);
    }
    if (!sidebarOpen) setBrandBump(false);
    if (sidebarOpen) {
      requestAnimationFrame(() => applySheetSnapCss(sheetSnapRef.current));
    }
  }, [sidebarOpen, applySheetSnapCss]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("sidebar-tree-open", sidebarOpen);
    root.classList.toggle("sidebar-tree-collapsed", !sidebarOpen);
  }, [sidebarOpen]);

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) =>
      (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt),
    );
    return sorted.slice(0, 8);
  }, [sessions]);

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );

  useEffect(() => {
    if (!railRecentsPos) return;
    const onDown = (e: MouseEvent) => {
      if (railRecentsRef.current?.contains(e.target as Node)) return;
      setRailRecentsPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailRecentsPos(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [railRecentsPos]);

  useEffect(() => {
    if (!railSettingsMenu) return;
    const onDown = (e: MouseEvent) => {
      if (railSettingsRef.current?.contains(e.target as Node)) return;
      setRailSettingsMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailSettingsMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [railSettingsMenu]);

  const openRailRecents = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRailFolderPicker(null);
    setRailRecentsPos({
      x: Math.min(rect.right + 8, window.innerWidth - 300),
      y: Math.min(rect.top, window.innerHeight - 360),
    });
  };

  const openRailSettings = (
    e: ReactMouseEvent<HTMLButtonElement>,
    section: SettingsSection,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRailRecentsPos(null);
    setRailFolderPicker(null);
    setRailSettingsMenu({
      section,
      x: Math.min(rect.right + 8, window.innerWidth - 300),
      y: Math.min(rect.top, window.innerHeight - 420),
    });
  };

  const openRailNewChat = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRailRecentsPos(null);
    setRailFolderPicker({ x: rect.right + 8, y: rect.top });
  };

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent) => {
      if (window.innerWidth < 900) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      setDragging(true);
    },
    [sidebarWidth],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (window.innerWidth < 900) return;
    setSidebarOpen(!sidebarOpen);
  }, [sidebarOpen, setSidebarOpen]);

  const sheetDismissingRef = useRef(false);
  const ignoreSheetDismissUntilRef = useRef(0);

  const openSheetAt = useCallback(
    (snapIndex: number) => {
      ignoreSheetDismissUntilRef.current = Date.now() + 500;
      sheetSnapRef.current = snapIndex;
      sheetDismissingRef.current = false;
      setSidebarOpen(true);
      requestAnimationFrame(() => applySheetSnapCss(snapIndex));
    },
    [setSidebarOpen, applySheetSnapCss],
  );

  /** Mobile: slide the sheet off-screen, then unmount. Desktop: instant close. */
  const dismissSheet = useCallback(() => {
    if (window.innerWidth >= 900) {
      setSidebarOpen(false);
      return;
    }
    const el = sheetRef.current;
    if (!el) {
      setSidebarOpen(false);
      return;
    }
    if (sheetDismissingRef.current) return;
    sheetDismissingRef.current = true;
    delete el.dataset.dragging;
    delete el.dataset.undersize;
    el.dataset.closing = "true";
    const h = el.getBoundingClientRect().height;
    el.style.height = `${h}px`;
    el.style.maxHeight = "none";
    el.style.transform = "translateY(0)";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = "translateY(110%)";
      });
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener("transitionend", onEnd);
      sheetDismissingRef.current = false;
      delete el.dataset.closing;
      el.style.height = "";
      el.style.maxHeight = "";
      el.style.transform = "";
      setSidebarOpen(false);
    };
    const onEnd = (ev: TransitionEvent) => {
      if (ev.target !== el || ev.propertyName !== "transform") return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    window.setTimeout(finish, 480);
  }, [setSidebarOpen]);

  const snapSheetHeight = useCallback(
    (heightPx: number) => {
      const vh = window.innerHeight || 1;
      const minH = Math.max(sheetMinPx, vh * sheetSnaps[0] * 0.9);
      if (heightPx < minH) {
        dismissSheet();
        return;
      }
      const frac = heightPx / vh;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < sheetSnaps.length; i++) {
        const d = Math.abs(sheetSnaps[i] - frac);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      sheetSnapRef.current = best;
      applySheetSnapCss(best);
    },
    [dismissSheet, applySheetSnapCss, sheetSnaps, sheetMinPx],
  );

  const applyLiveSheetHeight = useCallback(
    (heightPx: number) => {
      const el = sheetRef.current;
      if (!el) return false;
      const maxH = window.innerHeight * sheetSnaps[sheetSnaps.length - 1];
      const next = Math.min(maxH, Math.max(48, heightPx));
      el.style.height = `${next}px`;
      el.style.maxHeight = "none";
      el.style.transform = "translateY(0)";
      if (next < sheetMinPx) el.dataset.undersize = "true";
      else delete el.dataset.undersize;
      return true;
    },
    [sheetSnaps, sheetMinPx],
  );

  const onSheetPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (window.innerWidth >= 900 || !sidebarOpen) return;
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.sheetGrabber}`)) return;
      const el = sheetRef.current;
      if (!el) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      sheetDragRef.current = {
        startY: e.clientY,
        lastY: e.clientY,
        startH: el.getBoundingClientRect().height,
      };
      el.dataset.dragging = "true";
    },
    [sidebarOpen],
  );

  const onSheetPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = sheetDragRef.current;
      if (!drag) return;
      drag.lastY = e.clientY;
      if (sheetDragRaf.current) return;
      sheetDragRaf.current = requestAnimationFrame(() => {
        sheetDragRaf.current = 0;
        const d = sheetDragRef.current;
        if (!d) return;
        applyLiveSheetHeight(d.startH + (d.startY - d.lastY));
      });
    },
    [applyLiveSheetHeight],
  );

  const onSheetPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = sheetDragRef.current;
      const el = sheetRef.current;
      sheetDragRef.current = null;
      if (sheetDragRaf.current) {
        cancelAnimationFrame(sheetDragRaf.current);
        sheetDragRaf.current = 0;
      }
      if (el) {
        delete el.dataset.dragging;
        delete el.dataset.undersize;
      }
      if (!drag || !el) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      const height = el.getBoundingClientRect().height;
      const minH = Math.max(sheetMinPx, (window.innerHeight || 1) * sheetSnaps[0] * 0.9);
      if (height < minH) {
        snapSheetHeight(height);
        return;
      }
      el.style.height = "";
      el.style.maxHeight = "";
      el.style.transform = "";
      snapSheetHeight(height);
    },
    [snapSheetHeight, sheetMinPx, sheetSnaps],
  );

  const onPullerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (window.innerWidth >= 900) return;
      // Keep this button in the DOM for the whole gesture. Unmounting it
      // (or setting pointer-events: none) fires pointercancel and the user
      // has to press again to keep dragging.
      setPullerHeld(true);
      const pointerId = e.pointerId;
      const startY = e.clientY;
      const drag = {
        pointerId,
        startY,
        lastY: startY,
        opened: false,
      };
      pullerDragRef.current = drag;

      const paintFromFinger = (clientY: number) => {
        const pulled = window.innerHeight - clientY;
        const painted = applyLiveSheetHeight(pulled);
        if (painted) {
          const el = sheetRef.current;
          if (el) el.dataset.dragging = "true";
        }
        return painted;
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        drag.lastY = ev.clientY;
        const up = drag.startY - ev.clientY;
        if (!drag.opened && up > 8) {
          drag.opened = true;
          ignoreSheetDismissUntilRef.current = Date.now() + 500;
          sheetSnapRef.current = 0;
          setSidebarOpen(true);
        }
        if (!drag.opened) return;
        if (sheetDragRaf.current) return;
        sheetDragRaf.current = requestAnimationFrame(() => {
          sheetDragRaf.current = 0;
          if (!pullerDragRef.current) return;
          if (!paintFromFinger(ev.clientY)) {
            requestAnimationFrame(() => paintFromFinger(ev.clientY));
          }
        });
      };

      const stopListen = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };

      let ended = false;
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || ended) return;
        if (ev.type === "pointercancel" && drag.opened) {
          // Keep waiting for pointerup; cancel here used to abort the drag.
          return;
        }
        ended = true;
        stopListen();
        setPullerHeld(false);
        const d = pullerDragRef.current;
        pullerDragRef.current = null;
        if (sheetDragRaf.current) {
          cancelAnimationFrame(sheetDragRaf.current);
          sheetDragRaf.current = 0;
        }
        if (!d) return;
        if (!d.opened) {
          if (ev.type === "pointercancel") return;
          openSheetAt(isSettings ? 1 : 2);
          return;
        }
        const finish = () => {
          const el = sheetRef.current;
          if (!el) return;
          delete el.dataset.dragging;
          delete el.dataset.undersize;
          const height = el.getBoundingClientRect().height;
          const minH = Math.max(sheetMinPx, (window.innerHeight || 1) * sheetSnaps[0] * 0.9);
          if (height < minH) {
            snapSheetHeight(height);
            return;
          }
          el.style.height = "";
          el.style.maxHeight = "";
          el.style.transform = "";
          snapSheetHeight(height);
        };
        if (sheetRef.current) finish();
        else requestAnimationFrame(finish);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [setSidebarOpen, applyLiveSheetHeight, openSheetAt, snapSheetHeight, isSettings, sheetMinPx, sheetSnaps],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = drag.startWidth + (e.clientX - drag.startX);
      if (next < SIDEBAR_COLLAPSE_AT) {
        setSidebarOpen(false);
        return;
      }
      if (!sidebarOpen) setSidebarOpen(true);
      const viewportMax = Math.max(SIDEBAR_MIN, window.innerWidth - SIDEBAR_VIEWPORT_MARGIN);
      setSidebarWidth(Math.min(SIDEBAR_MAX, viewportMax, Math.max(SIDEBAR_MIN, next)));
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
  }, [dragging, sidebarOpen, setSidebarOpen]);

  // MCP servers actually handed to the agent (enabled + has an endpoint URL).
  const enabledMcpServers = useMemo(
    () => (settings.mcpServers ?? []).filter((s) => s.enabled && s.url?.trim()),
    [settings.mcpServers],
  );

  // Live MCP server status (probed by the server), shown as dots in the tooltip.
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({});
  const mcpStatusSeq = useRef(0);
  const [pullerHeld, setPullerHeld] = useState(false);
  useEffect(() => {
    if (!agentTipOpen) return;
    const seq = ++mcpStatusSeq.current;
    api
      .mcpStatus()
      .then((s) => {
        if (seq === mcpStatusSeq.current) setMcpStatus(s);
      })
      .catch(() => {
        // offline server or transient failure — keep previous dots
      });
  }, [agentTipOpen, enabledMcpServers]);

  const goChat = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    if (window.innerWidth < 900) dismissSheet();
    navigate("/chat");
  }, [navigate, dismissSheet]);

  const goSettings = (section: SettingsSection, leaf?: SettingsLeaf) => {
    navigate(settingsPath(section, leaf ?? defaultLeafFor(section)));
    setOpenBranches((prev) => ({ ...prev, [section]: true }));
    if (window.innerWidth < 900) dismissSheet();
  };



  const shellStyle = (
    showSidebar
      ? {
          ["--sidebar-width"]: sidebarOpen ? `${sidebarWidth}px` : "0px",
        }
      : undefined
  ) as CSSProperties | undefined;

  const renderBrandButton = (opts?: { bump?: boolean }) => (
    <button
      type="button"
      className={`${styles.headerBrand}${opts?.bump && brandBump ? ` ${styles.brandBump}` : ""}`}
      onClick={goChat}
      title={t("common.goToChat")}
      aria-label={`Acpio ${BUILD_INFO.version}`}
    >
      <span className={styles.brandLetters} aria-hidden>
        {"Acpio".split("").map((ch, i) => (
          <span
            key={`${ch}-${i}`}
            className={`${styles.brandFlip}${i < 3 ? ` ${styles.brandMark}` : ""}`}
          >
            {ch}
          </span>
        ))}
      </span>
      <span className={styles.brandVersion} aria-hidden>
        {BUILD_INFO.version}
      </span>
    </button>
  );

  /** Settings search field: lives inside the tree top row, between the
   *  back-to-chat button and the collapse button. */
  const settingsSearchField = (
    <div className={styles.settingsSearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M16 16l4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      <input
        type="search"
        value={settingsQuery}
        onChange={(e) => setSettingsQuery(e.target.value)}
        placeholder={t("settings.searchPlaceholder")}
        aria-label={t("settings.searchPlaceholder")}
      />
      {settingsQuery ? (
        <button
          type="button"
          className={styles.settingsSearchClear}
          aria-label={t("settings.searchClear")}
          title={t("settings.searchClear")}
          onClick={() => setSettingsQuery("")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );

  return (
    <div
      className={`${styles.shell} ${showSidebar ? styles.withSidebar : styles.fullBleed} ${
        showSidebar && !sidebarOpen ? styles.sidebarCollapsed : ""
      } ${
        showSidebar && !sidebarOpen ? styles.shellDock : ""
      } ${railMode ? styles.railCollapsed : ""} ${dragging ? styles.resizing : ""}`}
      style={shellStyle}
    >
      {showSidebar && (
        <aside
          ref={sheetRef}
          className={`${styles.sidebar} ${sidebarOpen ? styles.open : ""} ${
            isChat ? styles.treeBrand : ""
          }`}
          role={sidebarOpen ? "dialog" : undefined}
          aria-modal={sidebarOpen ? true : undefined}
          aria-label={isSettings ? t("common.settingsSections") : t("common.openTree")}
          onPointerDown={onSheetPointerDown}
          onPointerMove={onSheetPointerMove}
          onPointerUp={onSheetPointerUp}
          onPointerCancel={onSheetPointerUp}
        >
          <div className={styles.sheetGrabber} aria-hidden />
          <div className={styles.brandRow}>
            {isSettings ? (
              <button type="button" className={styles.backBtn} onClick={goChat}>
                {t("common.backToChat")}
              </button>
            ) : (
              <span className={styles.sidebarBrand}>{renderBrandButton()}</span>
            )}
            <span className={styles.sheetTitle}>
              {isSettings ? t("common.openSettingsSheet") : t("common.openChatsSheet")}
            </span>
            <button
              type="button"
              className={styles.collapseBtn}
              aria-label={t("common.collapseTree")}
              title={t("common.collapseTree")}
              onClick={dismissSheet}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect
                  x="3.5"
                  y="4.5"
                  width="17"
                  height="15"
                  rx="3"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <path d="M9.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M14.2 9.2 11.5 12l2.7 2.8"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className={styles.sheetDone}
              aria-label={t("common.collapseTree")}
              title={t("common.collapseTree")}
              onClick={dismissSheet}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {isChat && (
            <ChatSidebar onOpenSearch={() => openSearch("chats")} />
          )}

          {isSettings && (
            <div className={styles.settingsSearchWrap}>
              {settingsSearchField}
              {settingsQuery.trim() ? (
                <p
                  className={`${styles.settingsSearchStatus}${
                    settingsTreeView.matches === 0 ? ` ${styles.settingsSearchStatusEmpty}` : ""
                  }`}
                >
                  {settingsTreeView.matches > 0
                    ? t("settings.searchResults", { count: settingsTreeView.matches })
                    : t("settings.searchNoResults")}
                </p>
              ) : null}
            </div>
          )}

          {isSettings && (
            <nav className={styles.settingsTree} aria-label={t("common.settingsSections")}>
              {settingsTreeView.branches.map((branch) => {
                const open =
                  settingsQuery.trim() || (openBranches[branch.id] ?? true);
                const activeBranch = settingsNav.section === branch.id;
                const hasChildren = branch.children.length > 0;

                return (
                  <div key={branch.id} className={styles.settingsBranch}>
                    <button
                      type="button"
                      className={`${styles.settingsItem} ${
                        activeBranch && !hasChildren ? styles.settingsItemActive : ""
                      } ${activeBranch && hasChildren ? styles.settingsItemParent : ""}`}
                      onClick={() => {
                        if (hasChildren) {
                          const switching = settingsNav.section !== branch.id;
                          setOpenBranches((prev) => ({
                            ...prev,
                            [branch.id]: switching ? true : !(prev[branch.id] ?? true),
                          }));
                          if (switching) goSettings(branch.id, defaultLeafFor(branch.id));
                        } else {
                          goSettings(branch.id);
                        }
                      }}
                    >
                      {hasChildren && (
                        <span className={styles.settingsChevron} aria-hidden>
                          {open ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                              <path
                                d="M6 9l6 6 6-6"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                              <path
                                d="M9 6l6 6-6 6"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </span>
                      )}
                      <span className={styles.settingsItemLabel}>
                        {settingsQuery.trim()
                          ? highlightText(branch.label, settingsQuery)
                          : branch.label}
                      </span>
                    </button>
                    {hasChildren && open && (
                      <div className={styles.settingsLeaves}>
                        {branch.children.map((leaf) => {
                          const active =
                            settingsNav.section === branch.id && settingsNav.leaf === leaf.id;
                          return (
                            <button
                              key={leaf.id}
                              type="button"
                              className={`${styles.settingsLeaf} ${
                                active ? styles.settingsItemActive : ""
                              }`}
                              onClick={() => goSettings(branch.id, leaf.id)}
                            >
                              {settingsQuery.trim()
                                ? highlightText(leaf.label, settingsQuery)
                                : leaf.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>
          )}
        </aside>
      )}

      {railMode && (
        <div className={styles.rail} role="toolbar" aria-label={t("common.sidebarRail")}>
          <button
            type="button"
            className={styles.railBtn}
            title={t("common.openTree")}
            aria-label={t("common.openTree")}
            onClick={() => {
              setRailRecentsPos(null);
              setRailFolderPicker(null);
              setSidebarOpen(true);
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect
                x="3.5"
                y="4.5"
                width="17"
                height="15"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <path d="M14.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M9.8 9.2 12.5 12l-2.7 2.8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {isSettings ? (
            settingsTree.map((branch) => {
              const active = settingsNav.section === branch.id;
              return (
                <button
                  key={branch.id}
                  type="button"
                  className={`${styles.railBtn}${active ? ` ${styles.railBtnActive}` : ""}`}
                  title={branch.label}
                  aria-label={branch.label}
                  aria-expanded={railSettingsMenu?.section === branch.id}
                  onClick={(e) => openRailSettings(e, branch.id)}
                >
                  {branch.id === "agent" ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M12 3.2v2.8"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                      <rect
                        x="4.5"
                        y="6.5"
                        width="15"
                        height="11.5"
                        rx="3"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      />
                      <circle cx="9.5" cy="12" r="1.3" fill="currentColor" />
                      <circle cx="14.5" cy="12" r="1.3" fill="currentColor" />
                      <path
                        d="M9.5 15.5h5"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <rect
                        x="2.8"
                        y="4.5"
                        width="18.4"
                        height="12.5"
                        rx="2.5"
                        stroke="currentColor"
                        strokeWidth="1.7"
                      />
                      <path
                        d="M9.5 21h5M12 17v4"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
              );
            })
          ) : (
            <>
              <button
                type="button"
                className={styles.railBtn}
                title={t("common.newChat")}
                aria-label={t("common.newChat")}
                onClick={openRailNewChat}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M5.5 4.8h9.2A3.3 3.3 0 0 1 18 8.1v5.2a3.3 3.3 0 0 1-3.3 3.3H10l-3.4 2.6v-2.6H5.5A3.3 3.3 0 0 1 2.2 13.3V8.1A3.3 3.3 0 0 1 5.5 4.8Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M16.8 3.2 17.5 5.2 19.5 5.9 17.5 6.6 16.8 8.6 16.1 6.6 14.1 5.9 16.1 5.2 16.8 3.2Z"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles.railBtn}
                title={t("common.railRecents")}
                aria-label={t("common.railRecents")}
                onClick={openRailRecents}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.7" />
                  <path
                    d="M12 7.4V12l3 2"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {searchEnabled ? (
                <button
                  type="button"
                  className={styles.railBtn}
                  title={t("chat.searchDialogTitle")}
                  aria-label={t("chat.searchDialogTitle")}
                  onClick={() => openSearch("chats")}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
                    <path
                      d="M16 16l4.5 4.5"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ) : null}
            </>
          )}
          <div className={styles.railSpacer} />

          {railRecentsPos &&
            createPortal(
              <div
                ref={railRecentsRef}
                className={styles.railMenu}
                style={{ left: railRecentsPos.x, top: railRecentsPos.y }}
                role="menu"
                aria-label={t("common.railRecents")}
              >
                <div className={styles.railMenuHead}>{t("common.railRecents")}</div>
                {recentSessions.length === 0 ? (
                  <p className={styles.railMenuEmpty}>{t("common.railNoRecents")}</p>
                ) : (
                  recentSessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      className={styles.railMenuItem}
                      onClick={() => {
                        setRailRecentsPos(null);
                        void selectSession(s.id);
                        navigate("/chat");
                      }}
                    >
                      <span className={styles.railMenuItemText}>{s.title}</span>
                    </button>
                  ))
                )}
              </div>,
              document.body,
            )}

          {railSettingsMenu && (
            (() => {
              const branch = settingsTree.find((b) => b.id === railSettingsMenu.section);
              if (!branch) return null;
              return createPortal(
                <div
                  ref={railSettingsRef}
                  className={styles.railMenu}
                  style={{ left: railSettingsMenu.x, top: railSettingsMenu.y }}
                  role="menu"
                  aria-label={branch.label}
                >
                  <div className={styles.railMenuHead}>{branch.label}</div>
                  {branch.children.map((leaf) => {
                    const active =
                      settingsNav.section === branch.id && settingsNav.leaf === leaf.id;
                    return (
                      <button
                        key={leaf.id}
                        type="button"
                        role="menuitem"
                        className={`${styles.railMenuItem}${
                          active ? ` ${styles.railMenuItemActive}` : ""
                        }`}
                        onClick={() => {
                          setRailSettingsMenu(null);
                          goSettings(branch.id, leaf.id);
                        }}
                      >
                        <span className={styles.railMenuItemText}>{leaf.label}</span>
                        {active ? (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden
                            className={styles.railMenuItemCheck}
                          >
                            <path
                              d="M5 12.5l4.5 4.5L19 7.5"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : null}
                      </button>
                    );
                  })}
                </div>,
                document.body,
              );
            })()
          )}
        </div>
      )}

      {railFolderPicker && (
        <CreateSessionFolderPicker
          x={railFolderPicker.x}
          y={railFolderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          dialogStartPath={settings.defaultCwd ?? ""}
          recentCwds={recentCwds}
          agents={harnessIds.map((id) => ({
            id,
            label: adapters.find((a) => a.id === id)?.label ?? harnessShortLabel(id),
            online: agentAvailability[id] === true,
          }))}
          preferredProvider={settings.defaultProvider}
          onClose={() => setRailFolderPicker(null)}
          onConfirm={async (cwd, provider) => {
            setRailFolderPicker(null);
            try {
              await createSession(cwd, provider);
              navigate("/chat");
            } catch (err) {
              showToast(
                err instanceof Error && err.message === "noAgentsOnline"
                  ? t("common.noAgentsOnline")
                  : err instanceof Error
                    ? err.message
                    : String(err),
                { tone: "danger" },
              );
            }
          }}
          onOpenExisting={async (row) => {
            setRailFolderPicker(null);
            try {
              await importHarnessSession({
                provider: row.provider,
                acpSessionId: row.acpSessionId,
                cwd: row.cwd,
                title: row.title,
              });
              navigate("/chat");
            } catch (err) {
              showToast(
                err instanceof Error && err.message === "alreadyInTree"
                  ? t("chat.alreadyInTree")
                  : err instanceof Error
                    ? err.message
                    : String(err),
                { tone: "danger" },
              );
            }
          }}
        />
      )}

      {showSidebar && sidebarOpen && (
        <div
          className={styles.splitter}
          onPointerDown={onSplitterDown}
          onDoubleClick={onSplitterDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeTree")}
          aria-valuenow={sidebarWidth}
          aria-valuemin={0}
          aria-valuemax={SIDEBAR_MAX}
          title={t("common.resizeTreeHint")}
        />
      )}

      {showSidebar && sidebarOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label={t("common.closeMenu")}
          onClick={() => {
            if (Date.now() < ignoreSheetDismissUntilRef.current) return;
            dismissSheet();
          }}
        />
      )}

      <div className={styles.main}>
        <header className={styles.header}>
          {/* Desktop: header burger. Mobile: bottom sheet puller. */}
          {showSidebar ? (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.headerTreeBtn}${sidebarOpen ? ` ${styles.iconBtnGhost} ${styles.iconBtnOpen}` : ""}${isSettings ? ` ${styles.iconBtnSettings}` : ""}`}
              aria-label={t("common.openTree")}
              title={t("common.openTree")}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : null}
          <span className={styles.headerBrandSlot}>
            {isSettings ? (
              <button
                type="button"
                className={styles.headerBackToChat}
                onClick={goChat}
                title={t("common.goToChat")}
                aria-label={t("common.backToChat")}
              >
                <span className={styles.headerBackToChatIcon} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M14.2 5.8 8.5 12l5.7 6.2"
                      stroke="currentColor"
                      strokeWidth="2.15"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className={styles.headerBackToChatLabel}>{t("common.navChat")}</span>
              </button>
            ) : null}
            <span
              className={
                isSettings ? styles.headerBrandHideOnMobile : styles.headerBrandWrap
              }
            >
              {renderBrandButton({ bump: true })}
            </span>
          </span>
          {!isSettings && headerSession ? (
            <>
              <HoverTip as="div" wrap className={styles.headerChatCtx} text={headerTitle}>
                {headerFolderLabel(headerSession.cwd) ? (
                  <>
                    <span className={styles.headerChatFolder}>
                      {headerFolderLabel(headerSession.cwd)}
                    </span>
                    <span className={styles.headerChatSep} aria-hidden>
                      /
                    </span>
                  </>
                ) : null}
                <span className={styles.headerChatTitle}>{headerTitle}</span>
              </HoverTip>
              <div className={styles.headerSpacerMobile} aria-hidden />
            </>
          ) : (
            <div className={styles.headerSpacer} />
          )}
          <div className={styles.headerActions}>
            <div ref={agentChipRef} className={styles.agentChipWrap}>
              <button
                type="button"
                className={`${styles.agentChip} ${
                  onlineHarnessCount > 0 ? styles.agentChipOn : styles.agentChipOff
                }`}
                aria-haspopup="true"
                aria-expanded={agentTipOpen}
                aria-label={agentStatusTitle}
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") openAgentTip();
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === "mouse") closeAgentTip();
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "mouse") setAgentTipOpen((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setAgentTipOpen((v) => !v);
                  }
                }}
              >
                <span className={styles.agentCount} aria-hidden>
                  {onlineHarnessCount}
                </span>
                <span className={styles.agentPip} aria-hidden />
              </button>
              {agentTipOpen ? (
                <div className={styles.agentTip} role="tooltip">
                  <div className={styles.agentTipHarnessList}>
                  {harnessIds.map((id) => {
                    const online = agentAvailability[id] === true;
                    const label =
                      adapters.find((a) => a.id === id)?.label ?? harnessShortLabel(id);
                    const modelId = modelForProvider(settings, id);
                    const model = modelId
                      ? modelDisplayName(modelId, undefined, t("models.default"))
                      : t("models.auto");
                    return (
                      <div key={id} className={styles.agentTipHarness}>
                        <div className={styles.agentTipRow}>
                          <span
                            className={`${styles.agentTipDot} ${online ? styles.agentTipDotOn : styles.agentTipDotOff}`}
                            aria-hidden
                          />
                          <span className={styles.agentTipName}>{label}</span>
                          <span className={online ? styles.agentTipOk : styles.agentTipBad}>
                            {online ? t("common.online") : t("common.offline")}
                          </span>
                        </div>
                        {online ? (
                          <div className={styles.agentTipLine}>
                            <span className={styles.agentTipLabel}>{t("settings.modelSection")}</span>
                            <span className={styles.agentTipValue} title={model}>
                              {model}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  </div>
                  <div className={styles.agentTipMcp}>
                    <div className={styles.agentTipMcpHead}>
                      <span className={styles.agentTipLabel}>{t("settings.mcpTitle")}</span>
                      {enabledMcpServers.length > 0 ? (
                        <span className={styles.agentTipMcpCount}>{enabledMcpServers.length}</span>
                      ) : null}
                    </div>
                    {enabledMcpServers.length === 0 ? (
                      <span className={styles.agentTipMuted}>{t("settings.mcpNone")}</span>
                    ) : (
                      <div className={styles.agentTipMcpList}>
                        {enabledMcpServers.map((s) => {
                          const st = mcpStatus[s.id];
                          const dotCls =
                            st === true
                              ? styles.agentTipMcpDotOk
                              : st === false
                                ? styles.agentTipMcpDotBad
                                : styles.agentTipMcpDotPending;
                          const dotTitle =
                            st === true
                              ? t("common.connected")
                              : st === false
                                ? t("common.notConnected")
                                : t("common.checking");
                          return (
                            <div key={s.id} className={styles.agentTipMcpRow}>
                              <span
                                className={`${styles.agentTipMcpDot} ${dotCls}`}
                                title={dotTitle}
                                aria-hidden
                              />
                              <span className={styles.agentTipMcpName} title={s.url}>
                                {s.name}
                              </span>
                              <span className={styles.agentTipMcpType}>
                                {s.type === "local" ? t("settings.mcpLocal") : t("settings.mcpRemote")}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className={styles.toolCluster} role="group" aria-label={t("common.toolbar")}>
              {(settings.chatHeaderIcons ?? []).includes("lang") && (
                <LocaleToggle triggerClassName={styles.toolClusterLocale} compact />
              )}
              {(settings.chatHeaderIcons ?? []).includes("install") && (
                <InstallAppButton className={styles.toolClusterBtn} />
              )}
              {(settings.chatHeaderIcons ?? []).includes("theme") && (
                <ThemeToggle
                  theme={theme}
                  className={styles.toolClusterBtn}
                  onToggle={() => void setTheme(theme === "light" ? "dark" : "light")}
                />
              )}
              <button
                type="button"
                className={`${styles.toolClusterBtn} ${styles.toolClusterSettings}${isSettings ? ` ${styles.toolClusterBtnActive}` : ""}`}
                aria-label={t("common.settings")}
                title={t("common.settings")}
                onClick={() => goSettings("agent", "connect")}
              >
                <svg
                  className={styles.toolClusterSettingsIcon}
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="M19.4 13a7.9 7.9 0 0 0 .1-2l2-1.5-2-3.5-2.3.7a8 8 0 0 0-1.7-1L15 3h-6l-.5 2.7a8 8 0 0 0-1.7 1L4.5 6 2.5 9.5l2 1.5a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.5 2.3-.7a8 8 0 0 0 1.7 1L9 21h6l.5-2.7a8 8 0 0 0 1.7-1l2.3.7 2-3.5-2-1.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </header>
        <div className={styles.content}>
          <ShellPage pathname={pathname} />
        </div>
      </div>

      {/* Mobile: bottom splitter — tap or drag up to open the tree sheet. */}
      {showSidebar ? (
        <button
          type="button"
          className={`${styles.sheetPuller}${sidebarOpen && !pullerHeld ? ` ${styles.sheetPullerHidden}` : ""}`}
          tabIndex={sidebarOpen ? -1 : 0}
          aria-hidden={sidebarOpen && !pullerHeld}
          aria-label={isSettings ? t("common.openSettingsSheet") : t("common.openChatsSheet")}
          onPointerDown={onPullerPointerDown}
        >
          <span className={styles.sheetPullerBar} aria-hidden />
        </button>
      ) : null}

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        initialTab={searchTab}
        chatsEnabled={isChatSearchEnabled(settings.chatTreeElements)}
        messagesEnabled={isChatSearchEnabled(settings.chatTreeElements)}
      />
    </div>
  );
}
