import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { modelDisplayName } from "@acprocess/shared";
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
import { ChatSidebar } from "./ChatSidebar";
import { collectRecentCwds, CreateSessionFolderPicker } from "./CreateSessionFolderPicker";
import { HoverTip } from "./HoverTip";
import { InstallAppButton } from "./InstallAppButton";
import { LocaleToggle } from "./LocaleToggle";
import { MessageSearchDialog } from "./MessageSearchDialog";
import { ThemeToggle } from "./ThemeToggle";
import { ChatPage } from "../pages/ChatPage";
import { SettingsPage } from "../pages/SettingsPage";
import styles from "./AppShell.module.css";

const SIDEBAR_WIDTH_KEY = "acprocess.sidebarWidth.v2";
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 1200;
const SIDEBAR_DEFAULT = 360;
const SIDEBAR_COLLAPSE_AT = 240;
/** Keep at least this much room for the chat column. */
const SIDEBAR_VIEWPORT_MARGIN = 320;

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
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const agentAvailable = useAppStore((s) => s.agentAvailable);
  const settings = useAppStore((s) => s.settings);
  const settingsTree = useMemo(() => getSettingsTree(t), [t]);

  const hasAgent = Boolean(settings.connectedProvider);
  // Green only when the agent was actually verified (probe/prompt succeeded),
  // not merely because "Connect" was pressed.
  const agentOnline = hasAgent && agentAvailable;

  const agentStatusTitle = useMemo(() => {
    const provider = settings.connectedProvider;
    const agent = !provider
      ? t("common.noAgent")
      : provider === "cursor"
        ? "Cursor"
        : provider === "omp"
          ? "OMP"
          : provider;
    return t("common.agentStatus", {
      agent,
      status: agentOnline ? t("common.online") : t("common.offline"),
    });
  }, [settings.connectedProvider, agentOnline, t]);

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

  const settingsNav = useMemo(() => parseSettingsSearch(search), [search]);
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>({
    agent: true,
  });
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [railRecentsPos, setRailRecentsPos] = useState<{ x: number; y: number } | null>(null);
  const [railFolderPicker, setRailFolderPicker] = useState<{ x: number; y: number } | null>(null);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const railRecentsRef = useRef<HTMLDivElement>(null);

  const railMode = showSidebar && !sidebarOpen && settings.sidebarCollapse === "rail";

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) =>
      b.lastMessageAt.localeCompare(a.lastMessageAt),
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

  const openRailRecents = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRailFolderPicker(null);
    setRailRecentsPos({
      x: Math.min(rect.right + 8, window.innerWidth - 300),
      y: Math.min(rect.top, window.innerHeight - 360),
    });
  };

  const openRailNewChat = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setRailRecentsPos(null);
    setRailFolderPicker({ x: rect.right + 8, y: rect.top });
  };

  const openRailFind = useCallback(() => {
    setRailRecentsPos(null);
    setRailFolderPicker(null);
    setSidebarOpen(true);
    if (!isChat) navigate("/chat");
    setSearchFocusToken((n) => n + 1);
  }, [isChat, navigate]);

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

  const agentLabel = useMemo(() => {
    const provider = settings.connectedProvider;
    if (!provider) return t("common.noAgent");
    if (provider === "cursor") return "Cursor";
    if (provider === "omp") return "OMP";
    return provider;
  }, [settings.connectedProvider, t]);

  const modelName = useMemo(
    () =>
      settings.defaultModel
        ? modelDisplayName(settings.defaultModel, undefined, t("models.default"))
        : "—",
    [settings.defaultModel, t],
  );

  // MCP servers actually handed to the agent (enabled + has an endpoint URL).
  const enabledMcpServers = useMemo(
    () => (settings.mcpServers ?? []).filter((s) => s.enabled && s.url?.trim()),
    [settings.mcpServers],
  );

  // Live MCP server status (probed by the server), shown as dots in the tooltip.
  const [mcpStatus, setMcpStatus] = useState<Record<string, boolean>>({});
  const mcpStatusSeq = useRef(0);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
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
    if (window.innerWidth < 900) setSidebarOpen(false);
    navigate("/chat");
  }, [navigate, setSidebarOpen]);

  const goSettings = (section: SettingsSection, leaf?: SettingsLeaf) => {
    navigate(settingsPath(section, leaf ?? defaultLeafFor(section)));
    setOpenBranches((prev) => ({ ...prev, [section]: true }));
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const shellStyle = (
    showSidebar
      ? {
          ["--sidebar-width"]: sidebarOpen ? `${sidebarWidth}px` : "0px",
        }
      : undefined
  ) as CSSProperties | undefined;

  return (
    <div
      className={`${styles.shell} ${showSidebar ? styles.withSidebar : styles.fullBleed} ${
        showSidebar && !sidebarOpen ? styles.sidebarCollapsed : ""
      } ${railMode ? styles.railCollapsed : ""} ${dragging ? styles.resizing : ""}`}
      style={shellStyle}
    >
      {showSidebar && (
        <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ""}`}>
          <div className={styles.brandRow}>
            {isSettings && (
              <button type="button" className={styles.backBtn} onClick={goChat}>
                {t("common.backToChat")}
              </button>
            )}
            <button
              type="button"
              className={styles.collapseBtn}
              aria-label={t("common.collapseTree")}
              title={t("common.collapseTree")}
              onClick={() => setSidebarOpen(false)}
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
          </div>

          {isChat && (
            <ChatSidebar
              focusSearchSignal={searchFocusToken}
              onSearchMessages={() => setMessageSearchOpen(true)}
            />
          )}

          {isSettings && (
            <nav className={styles.settingsTree} aria-label={t("common.settingsSections")}>
              {settingsTree.map((branch) => {
                const open = openBranches[branch.id] ?? true;
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
                          setOpenBranches((prev) => ({
                            ...prev,
                            [branch.id]: !(prev[branch.id] ?? true),
                          }));
                          goSettings(branch.id, defaultLeafFor(branch.id));
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
                      <span className={styles.settingsItemLabel}>{branch.label}</span>
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
                              {leaf.label}
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
              const hasChildren = branch.children.length > 0;
              const active = settingsNav.section === branch.id;
              return (
                <button
                  key={branch.id}
                  type="button"
                  className={`${styles.railBtn}${active ? ` ${styles.railBtnActive}` : ""}`}
                  title={branch.label}
                  aria-label={branch.label}
                  onClick={() => {
                    setRailRecentsPos(null);
                    setRailFolderPicker(null);
                    if (hasChildren) {
                      setOpenBranches((prev) => ({ ...prev, [branch.id]: true }));
                      goSettings(branch.id, defaultLeafFor(branch.id));
                    } else {
                      goSettings(branch.id);
                    }
                  }}
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
              <button
                type="button"
                className={styles.railBtn}
                title={t("common.railFind")}
                aria-label={t("common.railFind")}
                onClick={openRailFind}
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
              <button
                type="button"
                className={styles.railBtn}
                title={t("chat.searchMessages")}
                aria-label={t("chat.searchMessages")}
                onClick={() => setMessageSearchOpen(true)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M7 3h10a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 17 16h-7.5l-3.5 3.4v-3.4H7A2.5 2.5 0 0 1 4.5 13.5v-8A2.5 2.5 0 0 1 7 3Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                  <circle cx="16.3" cy="15.7" r="2.7" stroke="currentColor" strokeWidth="1.6" />
                  <path
                    d="M18.4 17.8l2.2 2.2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
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

          {railFolderPicker && (
            <CreateSessionFolderPicker
              x={railFolderPicker.x}
              y={railFolderPicker.y}
              defaultCwd={settings.defaultCwd ?? ""}
              dialogStartPath={settings.defaultCwd ?? ""}
              recentCwds={recentCwds}
              onClose={() => setRailFolderPicker(null)}
              onConfirm={async (cwd) => {
                setRailFolderPicker(null);
                await createSession(cwd);
                navigate("/chat");
              }}
            />
          )}
        </div>
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
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className={styles.main}>
        <header className={styles.header}>
          {showSidebar && !sidebarOpen ? (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t("common.openTree")}
              title={t("common.openTree")}
              onClick={() => setSidebarOpen(true)}
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
          <button
            type="button"
            className={styles.headerBrand}
            onClick={goChat}
            title={t("common.goToChat")}
            aria-label="ACProcess chat"
          >
            <span className={styles.brandLetters} aria-hidden>
              {"ACProcess".split("").map((ch, i) => (
                <span
                  key={`${ch}-${i}`}
                  className={`${styles.brandFlip}${i < 3 ? ` ${styles.brandMark}` : ""}`}
                >
                  {ch}
                </span>
              ))}
            </span>
            <span className={styles.brandDivider} aria-hidden />
            <span className={styles.brandChatMark} aria-hidden>
              Chat
            </span>
          </button>
          <div className={styles.headerSpacer} />
          <div className={styles.headerActions}>
            <div
              ref={agentChipRef}
              className={styles.agentChipWrap}
            >
              <button
                type="button"
                className={styles.agentChip}
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
                <span
                  className={`${styles.dot} ${agentOnline ? styles.on : styles.off}`}
                  aria-hidden
                />
                <span className={styles.agentChipModel}>{modelName}</span>
              </button>
              {agentTipOpen ? (
                <div className={styles.agentTip} role="tooltip">
                  <div className={styles.agentTipRow}>
                    <span
                      className={`${styles.dot} ${agentOnline ? styles.on : styles.off}`}
                      aria-hidden
                    />
                    <span className={styles.agentTipName}>{agentLabel}</span>
                  </div>
                  <div className={styles.agentTipLine}>
                    <span className={styles.agentTipLabel}>{t("settings.modelSection")}</span>
                    <span className={styles.agentTipValue}>{settings.defaultModel || "—"}</span>
                  </div>
                  <div className={styles.agentTipLine}>
                    <span className={styles.agentTipLabel}>{t("common.status")}</span>
                    <span className={agentOnline ? styles.agentTipOk : styles.agentTipBad}>
                      {agentOnline ? t("common.connected") : t("common.notConnected")}
                    </span>
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
              <LocaleToggle triggerClassName={styles.toolClusterLocale} compact />
              <InstallAppButton className={styles.toolClusterBtn} />
              <ThemeToggle
                theme={theme}
                className={styles.toolClusterBtn}
                onToggle={() => void setTheme(theme === "light" ? "dark" : "light")}
              />
              <button
                type="button"
                className={`${styles.toolClusterBtn} ${styles.toolClusterSettings}${isSettings ? ` ${styles.toolClusterBtnActive}` : ""}`}
                aria-label={t("common.settings")}
                title={t("common.settings")}
                onClick={() => navigate(settingsPath("agent", "connect"))}
              >
                <svg
                  className={styles.toolClusterSettingsIcon}
                  width="18"
                  height="18"
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
      <MessageSearchDialog open={messageSearchOpen} onClose={() => setMessageSearchOpen(false)} />
    </div>
  );
}
