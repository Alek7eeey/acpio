import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentProvider, HarnessSessionDto, SessionDto } from "@acpio/shared";
import { SHELL_SESSION_PROVIDER } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { canonicalCwd } from "@acpio/shared";
import { ServerFolderBrowseDialog } from "./ServerFolderBrowseDialog";
import styles from "./AppShell.module.css";

function folderName(pathValue: string, fallback: string) {
  const normalized = canonicalCwd(pathValue);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || fallback;
}

function cwdMatchesFolder(sessionCwd: string, folderCwd: string) {
  const a = canonicalCwd(sessionCwd).toLowerCase();
  const b = canonicalCwd(folderCwd).toLowerCase();
  if (!b) return true;
  if (!a) return false;
  return a === b;
}

function parentPath(pathValue: string) {
  const normalized = canonicalCwd(pathValue);
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0) return "";
  const parent = normalized.slice(0, cut);
  if (parent.length <= 36) return parent;
  return `…${parent.slice(-34)}`;
}

/** Unique recent working folders from sessions + settings default. */
export function collectRecentCwds(
  sessions: SessionDto[],
  defaultCwd?: string | null,
  limit = 5,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const key = canonicalCwd(raw);
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    out.push((raw ?? "").trim());
  };
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  push(defaultCwd);
  for (const s of sorted) {
    push(s.cwd);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function clampPopover(x: number, y: number, width = 380, height = 360) {
  const margin = window.innerWidth < 640 ? 12 : 8;
  const maxW = Math.min(width, window.innerWidth - margin * 2);
  const left = Math.min(Math.max(margin, x), window.innerWidth - maxW - margin);
  const top = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
  return { left, top, width: maxW };
}

function useMobileFolderSheet() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 900,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

const agentIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="12" cy="9" r="3.2" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M5.5 19.2c.8-3 3.4-5 6.5-5s5.7 2 6.5 5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const folderIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

type SessionTarget = AgentProvider | typeof SHELL_SESSION_PROVIDER;

type AgentOption = { id: AgentProvider; label: string; online: boolean };

type CreateSessionFolderPickerProps = {
  x: number;
  y: number;
  /** Soft default from settings — used if user doesn't pick a folder. */
  defaultCwd?: string;
  /** Preferred start folder for the folder dialog (not shown until picked). */
  dialogStartPath?: string;
  /**
   * When set (including ""), skip folder picking: create in this working
   * directory after the user chooses an agent.
   */
  lockedCwd?: string;
  recentCwds: string[];
  agents: AgentOption[];
  /** Pre-select this harness when it is online. */
  preferredProvider?: AgentProvider | null;
  onClose: () => void;
  onConfirm: (cwd: string, provider: SessionTarget) => void | Promise<void>;
  onOpenExisting?: (session: HarnessSessionDto) => void | Promise<void>;
  onCreateBoard?: (name: string) => void | Promise<void>;
  /** Session kind the picker opens on (the rail's boards button lands on "board"). */
  initialKind?: "agent" | "terminal" | "board";
  /**
   * Drop the kind switch: only an agent session can be created. The board's
   * task picker uses it — a board task is always an agent chat, never a shell.
   */
  agentOnly?: boolean;
};

export function CreateSessionFolderPicker({
  x,
  y,
  defaultCwd = "",
  dialogStartPath = "",
  lockedCwd,
  recentCwds,
  agents,
  preferredProvider,
  onClose,
  onConfirm,
  onOpenExisting,
  onCreateBoard,
  initialKind = "agent",
  agentOnly = false,
}: CreateSessionFolderPickerProps) {
  const t = useT();
  const [searchQuery, setSearchQuery] = useState("");
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false);
  const [browseDialogMode, setBrowseDialogMode] = useState<"select" | "create">("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onlineAgents = useMemo(() => agents.filter((a) => a.online), [agents]);
  const [provider, setProvider] = useState<AgentProvider | null>(() => {
    // Settings promise the default agent is what a new chat opens with, so it
    // outranks the remembered agent: the memory may step in only when that one
    // cannot be used (offline or unset), never as a way around the setting.
    if (preferredProvider && onlineAgents.some((a) => a.id === preferredProvider)) {
      return preferredProvider;
    }
    let lastSelected: AgentProvider | null = null;
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem("acpio.lastSelectedProvider.v1");
        if (raw) lastSelected = raw as AgentProvider;
      } catch {
        // ignore
      }
    }
    if (lastSelected && onlineAgents.some((a) => a.id === lastSelected)) {
      return lastSelected;
    }
    return onlineAgents[0]?.id ?? null;
  });
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [sessionKind, setSessionKind] = useState<"agent" | "terminal" | "board">(
    agentOnly ? "agent" : initialKind,
  );
  const [boardName, setBoardName] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const agentRowRef = useRef<HTMLDivElement>(null);
  const agentSubmenuRef = useRef<HTMLDivElement>(null);
  const agentCloseTimer = useRef<number | null>(null);
  const existingRowRef = useRef<HTMLDivElement>(null);
  const existingSubmenuRef = useRef<HTMLDivElement>(null);
  const existingCloseTimer = useRef<number | null>(null);
  const [existingMenuOpen, setExistingMenuOpen] = useState(false);
  const [existing, setExisting] = useState<HarnessSessionDto[]>([]);
  const [existingLoading, setExistingLoading] = useState(false);
  const mobileSheet = useMobileFolderSheet();

  const fallback = defaultCwd.trim();
  const dialogBlocked = browseDialogOpen;
  const lockFolder = lockedCwd != null;
  const lockedPath = lockFolder ? lockedCwd : "";

  const filteredRecents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return recentCwds;
    return recentCwds.filter((p) => p.toLowerCase().includes(q));
  }, [recentCwds, searchQuery]);

  useEffect(() => {
    if (lockFolder || mobileSheet) return;
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (sessionKind !== "agent" || !provider || !onOpenExisting || provider === SHELL_SESSION_PROVIDER) {
      setExisting([]);
      setExistingLoading(false);
      return;
    }
    let cancelled = false;
    setExistingLoading(true);
    void api
      .listHarnessSessions(provider, lockFolder ? lockedPath : defaultCwd || undefined)
      .then((rows) => {
        if (!cancelled) setExisting(rows);
      })
      .catch(() => {
        if (!cancelled) setExisting([]);
      })
      .finally(() => {
        if (!cancelled) setExistingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKind, provider, lockFolder, lockedPath, defaultCwd, onOpenExisting]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (dialogBlocked) return;
      if (mobileSheet) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (dialogBlocked) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, dialogBlocked, mobileSheet]);

  useEffect(() => {
    return () => {
      if (agentCloseTimer.current != null) window.clearTimeout(agentCloseTimer.current);
      if (existingCloseTimer.current != null) window.clearTimeout(existingCloseTimer.current);
    };
  }, []);

  const openAgentMenu = () => {
    if (agentCloseTimer.current != null) {
      window.clearTimeout(agentCloseTimer.current);
      agentCloseTimer.current = null;
    }
    setExistingMenuOpen(false);
    setAgentMenuOpen(true);
  };

  const scheduleCloseAgentMenu = () => {
    if (mobileSheet) return;
    if (agentCloseTimer.current != null) window.clearTimeout(agentCloseTimer.current);
    agentCloseTimer.current = window.setTimeout(() => setAgentMenuOpen(false), 160);
  };

  useLayoutEffect(() => {
    if (!agentMenuOpen || mobileSheet) return;
    const row = agentRowRef.current;
    const menu = agentSubmenuRef.current;
    if (!row || !menu) return;
    const r = row.getBoundingClientRect();
    const w = menu.offsetWidth || 240;
    const spaceRight = window.innerWidth - r.right - 10;
    if (spaceRight < w && r.left > w + 10) {
      menu.style.left = "auto";
      menu.style.right = "calc(100% + 6px)";
    } else {
      menu.style.left = "calc(100% + 6px)";
      menu.style.right = "auto";
    }
  }, [agentMenuOpen, mobileSheet, onlineAgents.length]);

  const openExistingMenu = () => {
    if (existingCloseTimer.current != null) {
      window.clearTimeout(existingCloseTimer.current);
      existingCloseTimer.current = null;
    }
    setAgentMenuOpen(false);
    setExistingMenuOpen(true);
  };

  const scheduleCloseExistingMenu = () => {
    if (mobileSheet) return;
    if (existingCloseTimer.current != null) window.clearTimeout(existingCloseTimer.current);
    existingCloseTimer.current = window.setTimeout(() => setExistingMenuOpen(false), 160);
  };

  useLayoutEffect(() => {
    if (!existingMenuOpen || mobileSheet) return;
    const row = existingRowRef.current;
    const menu = existingSubmenuRef.current;
    if (!row || !menu) return;
    const r = row.getBoundingClientRect();
    const w = menu.offsetWidth || 280;
    const spaceRight = window.innerWidth - r.right - 10;
    if (spaceRight < w && r.left > w + 10) {
      menu.style.left = "auto";
      menu.style.right = "calc(100% + 6px)";
    } else {
      menu.style.left = "calc(100% + 6px)";
      menu.style.right = "auto";
    }
  }, [existingMenuOpen, mobileSheet, existing.length, existingLoading]);

  const confirmPath = async (path: string, nextProvider?: SessionTarget) => {
    if (busy) return;
    const chosen = nextProvider ?? (sessionKind === "terminal" ? SHELL_SESSION_PROVIDER : provider);
    if (!chosen) {
      setError(t("common.pickAgent"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(path, chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const openExisting = async (row: HarnessSessionDto) => {
    if (busy || !onOpenExisting) return;
    setBusy(true);
    setError(null);
    try {
      await onOpenExisting(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const filteredExisting = useMemo(() => {
    const scoped = lockFolder ? existing.filter((row) => cwdMatchesFolder(row.cwd, lockedPath)) : existing;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(
      (row) =>
        row.title.toLowerCase().includes(q) ||
        row.cwd.toLowerCase().includes(q) ||
        row.acpSessionId.toLowerCase().includes(q),
    );
  }, [existing, searchQuery, lockFolder, lockedPath]);

  const existingItems = existingLoading ? (
    <p className={styles.pickerEmpty}>{t("chat.openExistingLoading")}</p>
  ) : filteredExisting.length ? (
    filteredExisting.map((row) => {
      const label = row.title || t("chat.untitledHarnessSession");
      const folder = row.cwd ? row.cwd.replace(/\\/g, "/") : "";
      return (
        <button
          key={row.acpSessionId}
          type="button"
          className={styles.pickerItem}
          title={folder ? `${label}\n${folder}` : label}
          disabled={busy}
          onClick={() => void openExisting(row)}
        >
          <span className={styles.pickerItemIcon} aria-hidden>
            {agentIcon}
          </span>
          <span className={styles.pickerExistingBody}>
            <span className={styles.pickerItemPath}>{label}</span>
            {folder ? <span className={styles.pickerExistingMeta}>{folder}</span> : null}
          </span>
        </button>
      );
    })
  ) : (
    <p className={styles.pickerEmpty}>{t("chat.openExistingEmpty")}</p>
  );

  const selectSessionKind = (kind: "agent" | "terminal" | "board") => {
    setSessionKind(kind);
    if (kind !== "agent") {
      setAgentMenuOpen(false);
      setExistingMenuOpen(false);
    }
  };

  const submitBoard = async () => {
    const name = boardName.trim();
    if (busy || !name || !onCreateBoard) return;
    setBusy(true);
    setError(null);
    try {
      await onCreateBoard(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const sessionKindSwitch = agentOnly ? null : (
    <div className={styles.pickerKindInline} role="tablist" aria-label={t("common.pickAgent")}>
      <button
        type="button"
        role="tab"
        aria-selected={sessionKind === "agent"}
        className={`${styles.pickerKindLink}${
          sessionKind === "agent" ? ` ${styles.pickerKindLinkOn}` : ""
        }`}
        disabled={busy}
        onClick={() => selectSessionKind("agent")}
      >
        {t("common.sessionKindAgent")}
      </button>
      <span className={styles.pickerKindSep} aria-hidden>
        /
      </span>
      <button
        type="button"
        role="tab"
        aria-selected={sessionKind === "terminal"}
        className={`${styles.pickerKindLink}${
          sessionKind === "terminal" ? ` ${styles.pickerKindLinkOn}` : ""
        }`}
        disabled={busy}
        onClick={() => selectSessionKind("terminal")}
      >
        {t("common.sessionKindTerminal")}
      </button>
      {lockFolder ? null : (
        <>
          <span className={styles.pickerKindSep} aria-hidden>
            /
          </span>
          <button
            type="button"
            role="tab"
            aria-selected={sessionKind === "board"}
            className={`${styles.pickerKindLink}${
              sessionKind === "board" ? ` ${styles.pickerKindLinkOn}` : ""
            }`}
            disabled={busy}
            onClick={() => selectSessionKind("board")}
          >
            {t("common.sessionKindBoard")}
          </button>
        </>
      )}
    </div>
  );

  const agentPicker =
    sessionKind === "agent" ? (
      onlineAgents.length ? (
        <div
          ref={agentRowRef}
          className={styles.pickerAgentHover}
          onPointerEnter={() => {
            if (!mobileSheet) openAgentMenu();
          }}
          onPointerLeave={scheduleCloseAgentMenu}
        >
          <button
            type="button"
            className={styles.pickerAction}
            disabled={busy}
            aria-expanded={agentMenuOpen}
            aria-haspopup="listbox"
            onClick={() => setAgentMenuOpen((v) => !v)}
            onFocus={() => {
              if (!mobileSheet) openAgentMenu();
            }}
          >
            <span className={styles.pickerItemIcon} aria-hidden>
              {agentIcon}
            </span>
            <span className={styles.pickerActionLabel}>
              {onlineAgents.find((a) => a.id === provider)?.label ?? t("common.pickAgent")}
            </span>
            <span
              className={`${styles.pickerActionChevron}${
                agentMenuOpen ? ` ${styles.pickerActionChevronOpen}` : ""
              }`}
              aria-hidden
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 5l7 7-7 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          {agentMenuOpen && mobileSheet ? (
            <div className={styles.pickerNestedModels} role="listbox" aria-label={t("common.pickAgent")}>
              {onlineAgents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={provider === a.id}
                  className={`${styles.pickerItem}${
                    provider === a.id ? ` ${styles.pickerItemActive}` : ""
                  }`}
                  disabled={busy}
                  onClick={() => {
                    setProvider(a.id);
                    setAgentMenuOpen(false);
                  }}
                >
                  <span className={styles.pickerItemIcon} aria-hidden>
                    {agentIcon}
                  </span>
                  <span className={styles.pickerItemPath}>{a.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {agentMenuOpen && !mobileSheet ? (
            <div
              ref={agentSubmenuRef}
              className={styles.pickerSubmenu}
              role="listbox"
              aria-label={t("common.pickAgent")}
              onPointerEnter={openAgentMenu}
              onPointerLeave={scheduleCloseAgentMenu}
            >
              <div className={styles.pickerSubmenuList}>
                {onlineAgents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={provider === a.id}
                    className={`${styles.pickerItem}${
                      provider === a.id ? ` ${styles.pickerItemActive}` : ""
                    }`}
                    disabled={busy}
                    onClick={() => {
                      setProvider(a.id);
                      setAgentMenuOpen(false);
                    }}
                  >
                    <span className={styles.pickerItemIcon} aria-hidden>
                      {agentIcon}
                    </span>
                    <span className={styles.pickerItemPath}>{a.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className={styles.pickerEmpty}>{t("common.noAgentsOnline")}</p>
      )
    ) : null;

  const existingHover =
    onOpenExisting && sessionKind === "agent" && provider && provider !== SHELL_SESSION_PROVIDER ? (
      <div
        ref={existingRowRef}
        className={styles.pickerAgentHover}
        onPointerEnter={() => {
          if (!mobileSheet) openExistingMenu();
        }}
        onPointerLeave={scheduleCloseExistingMenu}
      >
        <button
          type="button"
          className={styles.pickerAction}
          disabled={busy}
          aria-expanded={existingMenuOpen}
          aria-haspopup="listbox"
          onClick={() => setExistingMenuOpen((v) => !v)}
          onFocus={() => {
            if (!mobileSheet) openExistingMenu();
          }}
        >
          <span className={styles.pickerItemIcon} aria-hidden>
            {agentIcon}
          </span>
          <span className={styles.pickerActionLabel}>{t("chat.pickExistingSessions")}</span>
          <span
            className={`${styles.pickerActionChevron}${
              existingMenuOpen ? ` ${styles.pickerActionChevronOpen}` : ""
            }`}
            aria-hidden
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 5l7 7-7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
        {existingMenuOpen && mobileSheet ? (
          <div
            className={styles.pickerNestedModels}
            role="listbox"
            aria-label={t("chat.openExisting")}
          >
            {existingItems}
          </div>
        ) : null}
        {existingMenuOpen && !mobileSheet ? (
          <div
            ref={existingSubmenuRef}
            className={`${styles.pickerSubmenu} ${styles.pickerSubmenuWide}`}
            role="listbox"
            aria-label={t("chat.openExisting")}
            onPointerEnter={openExistingMenu}
            onPointerLeave={scheduleCloseExistingMenu}
          >
            <div className={styles.pickerSubmenuList}>{existingItems}</div>
          </div>
        ) : null}
      </div>
    ) : null;

  const pos = mobileSheet ? null : clampPopover(x, y);

  const pickerPanel = (
    <div
      ref={panelRef}
      className={`${styles.pickerPanel}${
        mobileSheet ? ` ${styles.folderPickerModal}` : ""
      }${lockFolder ? ` ${styles.pickerPanelCompact}` : ""}`}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={lockFolder ? t("chat.newInFolder") : t("common.workingDir")}
      onClick={(e) => e.stopPropagation()}
    >
      {lockFolder ? (
        <>
          <div className={styles.pickerHeadRow}>
            <div className={styles.pickerHead}>{t("chat.newInFolder")}</div>
            {sessionKindSwitch}
          </div>
          <div className={styles.pickerLockedCwd} title={lockedPath || undefined}>
            <span className={styles.pickerItemIcon} aria-hidden>
              {folderIcon}
            </span>
            <span className={styles.pickerItemPath}>
              {lockedPath
                ? folderName(lockedPath, t("common.noFolder"))
                : t("common.noFolder")}
            </span>
          </div>
          {agentPicker}
          {existingHover}
          <button
            type="button"
            className={styles.pickerCreateBtn}
            disabled={busy || (sessionKind === "agent" && !provider)}
            onClick={() => void confirmPath(lockedPath)}
          >
            {t("common.create")}
          </button>
          {error ? <p className={styles.popoverError}>{error}</p> : null}
        </>
      ) : (
        <>
      <div className={styles.pickerKindBar}>{sessionKindSwitch}</div>
      {agentPicker}

      {sessionKind === "board" ? (
        <div>
          <div className={styles.pickerHead}>{t("chat.newBoard")}</div>
          <input
            className={styles.pickerSearchInput}
            type="text"
            value={boardName}
            onChange={(e) => setBoardName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitBoard();
            }}
            placeholder={t("chat.boardName")}
            aria-label={t("chat.boardName")}
            autoFocus={!mobileSheet}
          />
          <button
            type="button"
            className={styles.pickerCreateBtn}
            disabled={busy || !boardName.trim() || !onCreateBoard}
            onClick={() => void submitBoard()}
          >
            {t("common.create")}
          </button>
        </div>
      ) : (
        <>
      {/* Search */}
      <div className={styles.pickerSearch}>
        <svg className={styles.pickerSearchIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          className={styles.pickerSearchInput}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("common.pickerSearchPlaceholder")}
          aria-label={t("common.pickerSearchPlaceholder")}
        />
        {searchQuery ? (
          <button
            type="button"
            className={styles.pickerSearchClear}
            aria-label={t("chat.clearSearch")}
            onClick={() => { setSearchQuery(""); searchRef.current?.focus(); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* Recents */}
      <div className={styles.pickerHead}>{t("common.recentFolders")}</div>
      {filteredRecents.length > 0 ? (
        <div className={styles.pickerList}>
          {filteredRecents.map((path) => (
            <button
              key={path}
              type="button"
              className={styles.pickerItem}
              title={path}
              disabled={busy}
              onClick={() => void confirmPath(path)}
            >
              <span className={styles.pickerItemIcon} aria-hidden>{folderIcon}</span>
              <span className={styles.pickerItemPath}>{path}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.pickerEmpty}>{t("common.railNoRecents")}</p>
      )}

      {/* Actions */}
      <div className={styles.pickerDivider} />
      <button
        type="button"
        className={styles.pickerAction}
        disabled={busy}
        onClick={() => { setBrowseDialogMode("select"); setBrowseDialogOpen(true); }}
      >
        <span className={styles.pickerItemIcon} aria-hidden>{folderIcon}</span>
        <span className={styles.pickerActionLabel}>{t("common.useExistingFolder")}</span>
        <span className={styles.pickerActionChevron} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        className={styles.pickerAction}
        disabled={busy}
        onClick={() => { setBrowseDialogMode("create"); setBrowseDialogOpen(true); }}
      >
        <span className={styles.pickerItemIcon} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.pickerActionLabel}>{t("common.newFolder")}</span>
        <span className={styles.pickerActionChevron} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
        </>
      )}

      {existingHover}

      {error ? <p className={styles.popoverError}>{error}</p> : null}
        </>
      )}
    </div>
  );

  return createPortal(
    <>
      {mobileSheet ? (
        <div
          className={`${styles.folderPickerOverlay}${
            browseDialogOpen ? ` ${styles.folderPickerOverlayHidden}` : ""
          }`}
          role="presentation"
          onClick={() => {
            if (dialogBlocked) return;
            onClose();
          }}
        >
          {pickerPanel}
        </div>
      ) : (
        pickerPanel
      )}

      <ServerFolderBrowseDialog
        key={browseDialogMode}
        open={browseDialogOpen}
        mode={browseDialogMode}
        initialPath={dialogStartPath.trim() || fallback || undefined}
        onClose={() => {
          setBrowseDialogOpen(false);
        }}
        onSelect={(path) => {
          setBrowseDialogOpen(false);
          void confirmPath(path);
        }}
      />
    </>,
    document.body,
  );
}
