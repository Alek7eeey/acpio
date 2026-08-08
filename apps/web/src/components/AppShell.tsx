import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "../lib/store";
import {
  SETTINGS_TREE,
  parseSettingsSearch,
  settingsPath,
  defaultLeafFor,
  type SettingsSection,
  type SettingsLeaf,
} from "../lib/settingsNav";
import { ChatSidebar } from "./ChatSidebar";
import { HoverTip } from "./HoverTip";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./AppShell.module.css";

const SIDEBAR_WIDTH_KEY = "acprocess.sidebarWidth.v2";
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 360;
const SIDEBAR_COLLAPSE_AT = 240;

function readStoredWidth() {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(raw)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw));
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const connected = useAppStore((s) => s.connected);
  const settings = useAppStore((s) => s.settings);

  const isChat = location.pathname.startsWith("/chat");
  const isGitea = location.pathname.startsWith("/gitea");
  const isSettings = location.pathname.startsWith("/settings");
  const showSidebar = isChat || isGitea || isSettings;

  const settingsNav = useMemo(
    () => parseSettingsSearch(location.search),
    [location.search],
  );
  const [openBranches, setOpenBranches] = useState<Record<string, boolean>>({
    agent: true,
    account: true,
    gitea: true,
  });
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent) => {
      if (window.innerWidth < 900) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: sidebarOpen ? sidebarWidth : SIDEBAR_MIN };
      setDragging(true);
      if (!sidebarOpen) setSidebarOpen(true);
    },
    [sidebarOpen, sidebarWidth, setSidebarOpen],
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
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
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

  const user = useAppStore((s) => s.user);
  const logout = useAppStore((s) => s.logout);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  const displayLabel = user?.displayName || user?.username || "Пользователь";
  const userInitial = (displayLabel[0] ?? "?").toUpperCase();

  useEffect(() => {
    if (!accountOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  const title = isGitea
    ? "Gitea"
    : isSettings
      ? "Настройки"
      : isChat
        ? "AI-чат"
        : "Дашборд";

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
      } ${dragging ? styles.resizing : ""}`}
      style={shellStyle}
    >
      {showSidebar && (
        <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ""}`}>
          <div className={styles.brandRow}>
            <button
              type="button"
              className={styles.backBtn}
              onClick={() => {
                navigate("/");
                if (window.innerWidth < 900) setSidebarOpen(false);
              }}
            >
              ← Дашборд
            </button>
            <button
              type="button"
              className={styles.collapseBtn}
              aria-label="Свернуть дерево"
              title="Свернуть дерево"
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

          <div className={styles.moduleTitle}>{title}</div>

          {isChat && <ChatSidebar />}

          {isGitea && (
            <div className={styles.modulePanel}>
              <div className={styles.metaRow}>
                <span>URL</span>
                <strong>{settings.giteaBaseUrl || "—"}</strong>
              </div>
              <div className={styles.metaRow}>
                <span>Repo</span>
                <strong>
                  {settings.giteaOwner || "—"}/{settings.giteaRepo || "—"}
                </strong>
              </div>
              <p className={styles.emptyHint}>
                Коммиты, PR и конфликты — в основной панели справа.
              </p>
            </div>
          )}

          {isSettings && (
            <nav className={styles.settingsTree} aria-label="Разделы настроек">
              {SETTINGS_TREE.map((branch) => {
                const open = openBranches[branch.id] ?? true;
                const activeBranch = settingsNav.section === branch.id;
                const hasChildren = branch.children.length > 0;
                const disabled = branch.id === "gitea";

                if (disabled) {
                  return (
                    <div key={branch.id} className={styles.settingsBranch}>
                      <HoverTip
                        className={`${styles.settingsItem} ${styles.settingsItemDisabled}`}
                        aria-disabled="true"
                      >
                        <span className={styles.settingsItemLabel}>{branch.label}</span>
                      </HoverTip>
                    </div>
                  );
                }

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

      {showSidebar && (
        <div
          className={`${styles.splitter} ${!sidebarOpen ? styles.splitterCollapsed : ""}`}
          onPointerDown={onSplitterDown}
          onDoubleClick={onSplitterDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину дерева"
          aria-valuenow={sidebarOpen ? sidebarWidth : 0}
          aria-valuemin={0}
          aria-valuemax={SIDEBAR_MAX}
          title={
            sidebarOpen
              ? "Потяните, чтобы изменить ширину · двойной клик — свернуть"
              : "Потяните или двойной клик — открыть дерево"
          }
        />
      )}

      {showSidebar && sidebarOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label="Закрыть меню"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div className={styles.main}>
        <header className={styles.header}>
          {showSidebar && !sidebarOpen ? (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Открыть дерево"
              title="Открыть дерево"
              onClick={() => setSidebarOpen(true)}
            >
              ☰
            </button>
          ) : null}
          <button
            type="button"
            className={styles.headerBrand}
            onClick={() => navigate("/")}
            title="На дашборд"
          >
            <span className={styles.brandMark}>ACP</span>
            <span>rocess</span>
          </button>
          <div className={styles.headerSpacer} />
          <div className={styles.headerRight}>
            <span className={`${styles.dot} ${connected ? styles.on : ""}`} title="WebSocket" />
            <ThemeToggle
              theme={theme}
              onToggle={() => void setTheme(theme === "light" ? "dark" : "light")}
            />
            <div className={styles.accountWrap} ref={accountRef}>
              <button
                type="button"
                className={`${styles.accountBtn} ${accountOpen || isSettings ? styles.headerIconActive : ""}`}
                aria-label="Аккаунт"
                aria-expanded={accountOpen}
                aria-haspopup="menu"
                title="Аккаунт"
                onClick={() => setAccountOpen((v) => !v)}
              >
                <span className={styles.accountAvatar} aria-hidden>
                  {userInitial}
                </span>
              </button>
              {accountOpen && (
                <div className={styles.accountMenu} role="menu">
                  <div className={styles.accountMenuHead}>
                    <span className={styles.accountAvatarLg} aria-hidden>
                      {userInitial}
                    </span>
                    <div className={styles.accountMeta}>
                      <strong>{displayLabel}</strong>
                      <span>@{user?.username ?? "user"}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.accountMenuItem}
                    onClick={() => {
                      setAccountOpen(false);
                      navigate(settingsPath("agent", "connect"));
                    }}
                  >
                    Настройки
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${styles.accountMenuItem} ${styles.accountMenuDanger}`}
                    onClick={() => {
                      setAccountOpen(false);
                      void logout();
                    }}
                  >
                    Выйти
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
