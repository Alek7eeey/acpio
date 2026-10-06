import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ChatChangesMetrics, GitStatusDto, SessionStatus } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { formatGitErrorToast, shouldAwaitGitRepo } from "../lib/gitUi";
import { showToast } from "../lib/toast";
import { GitDiffStats } from "./GitDiffStats";
import styles from "./ComposerGitBar.module.css";

const gitStatusByCwd = new Map<string, GitStatusDto>();
/**
 * Branch lists learned from a full status, keyed by cwd. The periodic poll asks
 * for a summary (which carries no branch list) — without this the list would be
 * wiped seconds after the user opened the branch menu.
 */
const gitBranchesByCwd = new Map<string, string[]>();

function gitCwdKey(cwd: string | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/").toLowerCase();
}

/** What a branch deletion answered: done, or git refusing to lose unmerged commits. */
export type GitBranchDeleteOutcome = {
  ok: boolean;
  unmerged: boolean;
};

export function useGitStatus(
  sessionId: string | null,
  onStatusChange?: (status: GitStatusDto | null) => void,
  context?: {
    cwd?: string;
    hasCwd?: boolean;
    sessionStatus?: SessionStatus;
    streaming?: boolean;
    isEmptyChat?: boolean;
    gitPanelOpen?: boolean;
  },
) {
  const t = useT();
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const cwdRef = useRef(gitCwdKey(context?.cwd));
  cwdRef.current = gitCwdKey(context?.cwd);
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);

  const boundStatus = resolvedSessionId === sessionId ? status : null;
  const pending = resolvedSessionId !== sessionId;

  const applyStatus = useCallback(
    (next: GitStatusDto | null) => {
      const sid = sessionRef.current;
      if (!sid) {
        setStatus(null);
        setResolvedSessionId(null);
        onStatusChange?.(null);
        return;
      }
      const key = cwdRef.current;
      let resolved = next;
      if (next?.repo && key) {
        const cached = gitBranchesByCwd.get(key);
        if (next.branches.length > 0) {
          gitBranchesByCwd.set(key, next.branches);
        } else if (cached?.length) {
          const branches =
            next.branch && !cached.includes(next.branch)
              ? [...cached, next.branch].sort((a, b) => a.localeCompare(b))
              : cached;
          resolved = { ...next, branches };
        }
        gitStatusByCwd.set(key, resolved ?? next);
      }
      setStatus(resolved);
      setResolvedSessionId(sid);
      onStatusChange?.(resolved);
    },
    [onStatusChange],
  );

  const awaiting = shouldAwaitGitRepo({
    loading: pending,
    status: boundStatus,
    hasCwd: context?.hasCwd ?? Boolean(sessionId),
    sessionStatus: context?.sessionStatus,
    streaming: context?.streaming,
    isEmptyChat: context?.isEmptyChat,
  });

  const refresh = useCallback(
    async (opts?: { full?: boolean }) => {
      const sid = sessionRef.current;
      if (!sid) {
        setStatus(null);
        setResolvedSessionId(null);
        onStatusChange?.(null);
        return null;
      }
      const summary = !opts?.full && !context?.gitPanelOpen;
      try {
        const next = await api.gitStatus(sid, { summary });
        if (sessionRef.current !== sid) return null;
        applyStatus(next);
        return next;
      } catch {
        if (sessionRef.current !== sid) return null;
        applyStatus(null);
        return null;
      }
    },
    [applyStatus, context?.gitPanelOpen, onStatusChange],
  );

  /**
   * Fetch the full status (branch list included) for the open branch menu.
   * The composer poll only asks for a summary, so the menu would otherwise
   * offer just the current branch with no sign that more are coming.
   */
  const loadBranches = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    setBranchesLoading(true);
    try {
      const next = await api.gitStatus(sid, { summary: false });
      if (sessionRef.current !== sid) return;
      applyStatus(next);
    } catch {
      // Keep the branches we know; the menu just stops loading.
    } finally {
      setBranchesLoading(false);
    }
  }, [applyStatus]);

  useLayoutEffect(() => {
    setBranchesLoading(false);
  }, [sessionId]);

  useLayoutEffect(() => {
    const cwdKey = gitCwdKey(context?.cwd);
    if (!sessionId) {
      setResolvedSessionId(null);
      setStatus(null);
      return;
    }
    const cached = cwdKey ? gitStatusByCwd.get(cwdKey) : null;
    if (cached) {
      setStatus(cached);
      setResolvedSessionId(sessionId);
      return;
    }
    setResolvedSessionId(null);
    setStatus(null);
  }, [context?.cwd, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!context?.gitPanelOpen || !sessionId) return;
    void refresh({ full: true });
  }, [context?.gitPanelOpen, refresh, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const interval = awaiting ? 2000 : context?.gitPanelOpen ? 3000 : 8000;
    const timer = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(timer);
  }, [awaiting, context?.gitPanelOpen, refresh, sessionId]);

  const checkout = useCallback(async (branch: string, create = false) => {
    const sid = sessionRef.current;
    if (!sid || branchBusy) return;
    if (!create && branch === boundStatus?.branch) return;
    setBranchBusy(true);
    try {
      const result = await api.gitCheckout(sid, branch, create);
      if (sessionRef.current !== sid) return;
      applyStatus(result.status);
      showToast(t("git.checkoutOk"), { tone: "success" });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      showToast(formatGitErrorToast(raw, t, { context: "checkout" }), { tone: "danger" });
    } finally {
      setBranchBusy(false);
    }
  }, [applyStatus, boundStatus?.branch, branchBusy, t]);

  /**
   * Delete a local branch. The first call lets git refuse a branch whose commits
   * are not merged anywhere else; the caller asks the reader about losing them
   * and repeats the call with `force`. Both calls return the outcome, so the
   * question is asked by the surface that can phrase it with the branch name.
   */
  const deleteBranch = useCallback(
    async (branch: string, opts?: { force?: boolean }): Promise<GitBranchDeleteOutcome> => {
      const sid = sessionRef.current;
      if (!sid || branchBusy) return { ok: false, unmerged: false };
      setBranchBusy(true);
      try {
        const result = await api.gitDeleteBranch(sid, branch, opts?.force);
        if (sessionRef.current !== sid) return { ok: false, unmerged: false };
        applyStatus(result.status);
        if (result.ok) showToast(t("git.deleteBranchOk"), { tone: "success" });
        return { ok: result.ok, unmerged: result.unmerged };
      } catch (e) {
        const raw = e instanceof Error ? e.message : "";
        showToast(formatGitErrorToast(raw, t, { fallback: t("git.deleteBranchFailed") }), {
          tone: "danger",
        });
        return { ok: false, unmerged: false };
      } finally {
        setBranchBusy(false);
      }
    },
    [applyStatus, branchBusy, t],
  );

  return {
    status: boundStatus,
    loading: pending,
    awaiting,
    refresh,
    checkout,
    deleteBranch,
    branchBusy,
    branchesLoading,
    loadBranches,
    applyStatus,
  };
}

export function GitChangesChipLoader({
  premium = false,
  iconOnly = false,
}: {
  premium?: boolean;
  iconOnly?: boolean;
}) {
  const t = useT();
  return (
    <span
      className={`${styles.changesChip} ${styles.changesChipLoading}${
        iconOnly ? ` ${styles.changesChipIconOnly}` : ""
      }${premium ? ` ${styles.changesChipPremium}` : ""}`}
      aria-busy="true"
      aria-label={t("git.initializing")}
    >
      <span className={styles.loaderSpin} aria-hidden />
    </span>
  );
}

export function GitComposerLoadingBar({
  variant = "composerSubtle",
}: {
  variant?: "default" | "metaChip" | "composerFooter" | "composerSubtle";
}) {
  const t = useT();
  const premium = variant === "composerFooter";
  const iconOnly = variant === "metaChip";
  return (
    <div
      className={`${styles.bar} ${styles.barLoading}${
        variant === "metaChip" ? ` ${styles.barMetaChip}` : ""
      }${variant === "composerFooter" ? ` ${styles.barComposerFooter}` : ""}${
        variant === "composerSubtle" ? ` ${styles.barComposerSubtle}` : ""
      }`}
      aria-busy="true"
      aria-label={t("git.initializing")}
    >
      <span className={styles.loadingBranch} aria-hidden />
      <GitChangesChipLoader premium={premium} iconOnly={iconOnly} />
    </div>
  );
}

export function ComposerGitChangesButton({  status,
  changesOpen,
  onOpenChanges,
  iconOnly = false,
  premium = false,
  metrics = "linesAndFiles",
}: {
  status: GitStatusDto;
  changesOpen: boolean;
  onOpenChanges: () => void;
  /** Collapsed to the icon (row is squeezed, or the user hides the numbers). */
  iconOnly?: boolean;
  premium?: boolean;
  /** What the chip shows next to its icon. */
  metrics?: ChatChangesMetrics;
}) {
  const t = useT();
  const fileCount = status.files.length;
  const detail = status.dirty
    ? `+${status.additions} -${status.deletions} · ${t("git.changedFiles", { count: fileCount })}`
    : t("git.noChanges");
  const showLines = metrics === "lines" || metrics === "linesAndFiles";
  const showFiles = metrics === "files" || metrics === "linesAndFiles";
  // Git reports no line counts for untracked-only trees; "lines" then has
  // nothing to print, so the chip falls back to its icon + file badge rather
  // than rendering an empty pill.
  const linesAvailable = status.additions > 0 || status.deletions > 0;
  const collapsed = iconOnly || metrics === "none" || (metrics === "lines" && !linesAvailable);

  return (
    <button
      type="button"
      className={`${styles.changesChip}${changesOpen ? ` ${styles.changesChipActive}` : ""}${
        status.dirty ? "" : ` ${styles.changesChipQuiet}`
      }${collapsed ? ` ${styles.changesChipIconOnly}` : ""}${premium ? ` ${styles.changesChipPremium}` : ""}`}
      onClick={onOpenChanges}
      title={detail}
      aria-label={`${t("git.openChanges")}: ${detail}`}
      aria-pressed={changesOpen}
    >
      {collapsed ? (
        <>
          <svg className={styles.changesChipIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M7 7h10v10H7V7Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="M9 12h6M12 9v6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          {status.dirty ? <span className={styles.changesChipBadge}>{fileCount}</span> : null}
        </>
      ) : (
        <>
          {premium ? (
            <span className={styles.changesChipLeadIcon} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          ) : null}
          <span className={styles.changesChipMetrics}>
            {showLines ? (
              <GitDiffStats additions={status.additions} deletions={status.deletions} />
            ) : null}
            {showLines && showFiles ? (
              <span className={styles.changesChipSep} aria-hidden>
                ·
              </span>
            ) : null}
            {showFiles ? <span className={styles.changesChipCount}>{fileCount}</span> : null}
          </span>
        </>
      )}
    </button>
  );
}

export function GitBranchSwitcher({
  status,
  branchBusy,
  onCheckout,
  onDeleteBranch,
  onRequestFullStatus,
  branchesLoading = false,
  variant = "default",
  fixedMenu = false,
}: {
  status: GitStatusDto;
  branchBusy: boolean;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
  onDeleteBranch: (branch: string, opts?: { force?: boolean }) => Promise<GitBranchDeleteOutcome>;
  onRequestFullStatus?: () => void;
  /** The branch list has not arrived yet — the menu is showing a partial list. */
  branchesLoading?: boolean;
  variant?: "default" | "metaChip" | "panelHeader" | "composerSubtle";
  /** Portal the branch menu; required when the switcher sits in an overflow-hidden row. */
  fixedMenu?: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const useFixedMenu =
    fixedMenu || variant === "panelHeader" || variant === "metaChip";

  useLayoutEffect(() => {
    if (!menuOpen || !branchBtnRef.current) return;

    const updateMenu = () => {
      const btn = branchBtnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const gap = 6;
      const margin = 10;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openAbove = spaceBelow < 220 || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(140, Math.min(320, (openAbove ? spaceAbove : spaceBelow) - gap));

      if (useFixedMenu) {
        // The menu is wider than a squeezed switcher button, so anchoring it to
        // the button's left edge can push it past the viewport: clamp it inside,
        // keeping its own readable width.
        const width = Math.max(rect.width, 260);
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        const left = Math.min(Math.max(8, rect.left), maxLeft);
        setMenuStyle({
          position: "fixed",
          left,
          width,
          maxHeight,
          zIndex: 520,
          ...(openAbove
            ? { bottom: window.innerHeight - rect.top + gap }
            : { top: rect.bottom + gap }),
        });
      } else {
        setMenuStyle({
          top: openAbove ? "auto" : `calc(100% + ${gap}px)`,
          bottom: openAbove ? `calc(100% + ${gap}px)` : "auto",
          maxHeight,
        });
      }
    };

    updateMenu();
    window.addEventListener("resize", updateMenu);
    window.addEventListener("scroll", updateMenu, true);
    return () => {
      window.removeEventListener("resize", updateMenu);
      window.removeEventListener("scroll", updateMenu, true);
    };
  }, [menuOpen, status.branches.length, useFixedMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onRequestFullStatusRef = useRef(onRequestFullStatus);
  onRequestFullStatusRef.current = onRequestFullStatus;

  useEffect(() => {
    // Read the callback through a ref: the parent passes a fresh closure every
    // render, and depending on it here would refetch the branch list on each
    // of those renders while the menu stays open.
    if (!menuOpen) return;
    onRequestFullStatusRef.current?.();
  }, [menuOpen]);

  const branches = status.branches.length ? status.branches : status.branch ? [status.branch] : [];

  /**
   * The switcher sits inside the composer's own `<form>` when the branch bar is
   * the row under the input. A form inside a form is invalid DOM: the browser
   * truncates the inner submit event at the outer form, so React's onSubmit
   * never runs, the default GET submission reloads the app and the branch is
   * never created. The create row is therefore a plain div, and its action is
   * wired to the button and to Enter explicitly.
   */
  const createBranch = () => {
    const name = newBranch.trim();
    if (!name) return;
    void onCheckout(name, true).then(() => {
      setMenuOpen(false);
      setNewBranch("");
    });
  };

  /**
   * Deletion is asked twice on purpose: git only drops a branch whose commits
   * are merged somewhere else without `force`, so a second question — naming
   * what is lost — appears exactly when the commits would go with it.
   */
  const removeBranch = (branch: string) => {
    if (!window.confirm(t("git.deleteBranchConfirm", { branch }))) return;
    void onDeleteBranch(branch).then((result) => {
      if (!result.unmerged) return;
      if (!window.confirm(t("git.deleteBranchUnmergedConfirm", { branch }))) return;
      void onDeleteBranch(branch, { force: true });
    });
  };

  const switcherClass =
    variant === "panelHeader"
      ? `${styles.switcher} ${styles.switcherPanelHeader}`
      : styles.switcher;
  const branchBtnClass =
    variant === "panelHeader"
      ? `${styles.branchBtn} ${styles.branchBtnPanelHeader}`
      : variant === "composerSubtle"
        ? `${styles.branchBtn} ${styles.branchBtnComposerSubtle}`
        : styles.branchBtn;

  return (
    <div className={switcherClass} ref={rootRef}>
      <button
        ref={branchBtnRef}
        type="button"
        className={branchBtnClass}
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        title={t("git.switchBranch")}
        disabled={branchBusy}
      >
        {variant !== "panelHeader" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.branchIcon}>
            <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="17" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.6" />
            <path d="M9 7h6a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : null}
        <span className={styles.branchName}>{status.branch || "—"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.chevron}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menuOpen ? (
        (() => {
          const menu = (
            <div
              ref={menuRef}
              className={`${styles.menu}${useFixedMenu ? ` ${styles.menuFixed}` : ""}`}
              style={menuStyle}
              role="listbox"
              aria-label={t("git.switchBranch")}
            >
              {branchesLoading && branches.length <= 1 ? (
                <span className={styles.menuLoading} aria-live="polite">
                  <span className={styles.loaderSpin} aria-hidden />
                  {t("git.loadingBranches")}
                </span>
              ) : null}
              {branches.map((branch) => {
                // No delete for the checked-out branch or the repository's main
                // one: git drops a merged main without complaint, and the app
                // has no way back to it once it is gone.
                const deletable = !status.protectedBranches.includes(branch);
                return (
                  <div
                    key={branch}
                    className={`${styles.branchRow}${
                      branch === status.branch ? ` ${styles.branchRowActive}` : ""
                    }`}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={branch === status.branch}
                      className={styles.menuItem}
                      onClick={() =>
                        void onCheckout(branch).then(() => {
                          setMenuOpen(false);
                        })
                      }
                      disabled={branchBusy}
                    >
                      {branch}
                    </button>
                    {deletable ? (
                      <button
                        type="button"
                        className={styles.branchDelete}
                        title={t("git.deleteBranch")}
                        aria-label={t("git.deleteBranchLabel", { branch })}
                        onClick={() => removeBranch(branch)}
                        disabled={branchBusy}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                );
              })}
              <div className={styles.createBranch}>
                <input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    createBranch();
                  }}
                  placeholder={t("git.newBranchPlaceholder")}
                  aria-label={t("git.newBranchPlaceholder")}
                  disabled={branchBusy}
                />
                <button
                  type="button"
                  onClick={createBranch}
                  disabled={branchBusy || !newBranch.trim()}
                >
                  {t("git.createBranch")}
                </button>
              </div>
            </div>
          );
          return useFixedMenu && typeof document !== "undefined"
            ? createPortal(menu, document.body)
            : menu;
        })()
      ) : null}
    </div>
  );
}

export function ComposerGitBranchBar({
  status,
  branchBusy,
  onCheckout,
  onDeleteBranch,
  onLoadBranches,
  branchesLoading = false,
  changesOpen,
  onOpenChanges,
  variant = "default",
}: {
  status: GitStatusDto;
  branchBusy: boolean;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
  onDeleteBranch: (branch: string, opts?: { force?: boolean }) => Promise<GitBranchDeleteOutcome>;
  /** Called when the branch menu opens, to fetch the full branch list. */
  onLoadBranches?: () => void;
  branchesLoading?: boolean;
  changesOpen?: boolean;
  onOpenChanges?: () => void;
  variant?: "default" | "metaChip" | "composerFooter" | "composerSubtle";
}) {
  const t = useT();
  const premium = variant === "composerFooter";
  const branchVariant =
    variant === "metaChip"
      ? "metaChip"
      : variant === "composerSubtle"
        ? "composerSubtle"
        : "default";

  return (
    <div
      className={`${styles.bar}${variant === "metaChip" ? ` ${styles.barMetaChip}` : ""}${
        variant === "composerFooter" ? ` ${styles.barComposerFooter}` : ""
      }${variant === "composerSubtle" ? ` ${styles.barComposerSubtle}` : ""}`}
    >
      <GitBranchSwitcher
        status={status}
        branchBusy={branchBusy}
        onCheckout={onCheckout}
        onDeleteBranch={onDeleteBranch}
        onRequestFullStatus={onLoadBranches}
        branchesLoading={branchesLoading}
        variant={branchVariant}
      />

      {status.conflict ? (
        <span className={styles.conflictBadge} title={t("common.conflicts")}>
          {t("common.conflicts")}
        </span>
      ) : null}

      {onOpenChanges ? (
        <ComposerGitChangesButton
          status={status}
          changesOpen={changesOpen ?? false}
          onOpenChanges={onOpenChanges}
          iconOnly={variant === "metaChip"}
          premium={premium}
        />
      ) : null}
    </div>
  );
}
