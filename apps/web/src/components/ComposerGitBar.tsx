import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { GitStatusDto, SessionStatus } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { formatGitErrorToast, shouldAwaitGitRepo } from "../lib/gitUi";import { showToast } from "../lib/toast";
import { GitDiffStats } from "./GitDiffStats";
import styles from "./ComposerGitBar.module.css";

export function useGitStatus(
  sessionId: string | null,
  onStatusChange?: (status: GitStatusDto | null) => void,
  context?: {
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
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);

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
      setStatus(next);
      setResolvedSessionId(sid);
      onStatusChange?.(next);
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

  const refresh = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) {
      setStatus(null);
      setResolvedSessionId(null);
      onStatusChange?.(null);
      return null;
    }
    try {
      const next = await api.gitStatus(sid);
      if (sessionRef.current !== sid) return null;
      applyStatus(next);
      return next;
    } catch {
      if (sessionRef.current !== sid) return null;
      applyStatus(null);
      return null;
    }
  }, [applyStatus, onStatusChange]);

  useLayoutEffect(() => {
    setResolvedSessionId(null);
    setStatus(null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionId]);

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
      const raw = e instanceof Error ? e.message : t("git.checkoutFailed");
      showToast(formatGitErrorToast(raw, t, { context: "checkout" }), { tone: "danger" });
    } finally {
      setBranchBusy(false);
    }
  }, [applyStatus, boundStatus?.branch, branchBusy, t]);

  return { status: boundStatus, loading: pending, awaiting, refresh, checkout, branchBusy, applyStatus };
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
  variant?: "default" | "metaChip" | "composerFooter" | "composerMeta" | "composerSubtle";
}) {
  const t = useT();
  const premium = variant === "composerFooter";
  const iconOnly = variant === "metaChip" || variant === "composerMeta";
  return (
    <div
      className={`${styles.bar} ${styles.barLoading}${
        variant === "metaChip" ? ` ${styles.barMetaChip}` : ""
      }${variant === "composerMeta" ? ` ${styles.barComposerMeta}` : ""}${
        variant === "composerFooter" ? ` ${styles.barComposerFooter}` : ""
      }${variant === "composerSubtle" ? ` ${styles.barComposerSubtle}` : ""}`}
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
}: {
  status: GitStatusDto;
  changesOpen: boolean;
  onOpenChanges: () => void;
  iconOnly?: boolean;
  premium?: boolean;
}) {
  const t = useT();
  const fileCount = status.files.length;
  const detail = status.dirty
    ? `+${status.additions} -${status.deletions} · ${t("git.changedFiles", { count: fileCount })}`
    : t("git.noChanges");

  return (
    <button
      type="button"
      className={`${styles.changesChip}${changesOpen ? ` ${styles.changesChipActive}` : ""}${
        status.dirty ? "" : ` ${styles.changesChipQuiet}`
      }${iconOnly ? ` ${styles.changesChipIconOnly}` : ""}${premium ? ` ${styles.changesChipPremium}` : ""}`}
      onClick={onOpenChanges}
      title={detail}
      aria-label={`${t("git.openChanges")}: ${detail}`}
      aria-pressed={changesOpen}
    >
      {iconOnly ? (
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
            <GitDiffStats additions={status.additions} deletions={status.deletions} />
            <span className={styles.changesChipSep} aria-hidden>
              ·
            </span>
            <span className={styles.changesChipCount}>{fileCount}</span>
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
  variant = "default",
}: {
  status: GitStatusDto;
  branchBusy: boolean;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
  variant?: "default" | "metaChip" | "panelHeader" | "composerMeta" | "composerSubtle";
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const useFixedMenu = variant === "panelHeader";

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
        setMenuStyle({
          position: "fixed",
          left: rect.left,
          width: Math.max(rect.width, 260),
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
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const branches = status.branches.length ? status.branches : status.branch ? [status.branch] : [];

  const onCreateBranch = (e: FormEvent) => {
    e.preventDefault();
    const name = newBranch.trim();
    if (!name) return;
    void onCheckout(name, true).then(() => {
      setMenuOpen(false);
      setNewBranch("");
    });
  };

  const switcherClass =
    variant === "panelHeader"
      ? `${styles.switcher} ${styles.switcherPanelHeader}`
      : styles.switcher;
  const branchBtnClass =
    variant === "panelHeader"
      ? `${styles.branchBtn} ${styles.branchBtnPanelHeader}`
      : variant === "composerMeta"
        ? `${styles.branchBtn} ${styles.branchBtnComposerMeta}`
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
              {branches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  role="option"
                  aria-selected={branch === status.branch}
                  className={`${styles.menuItem}${branch === status.branch ? ` ${styles.menuItemActive}` : ""}`}
                  onClick={() =>
                    void onCheckout(branch).then(() => {
                      setMenuOpen(false);
                    })
                  }
                  disabled={branchBusy}
                >
                  {branch}
                </button>
              ))}
              <form className={styles.createBranch} onSubmit={onCreateBranch}>
                <input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder={t("git.newBranchPlaceholder")}
                  aria-label={t("git.newBranchPlaceholder")}
                  disabled={branchBusy}
                />
                <button type="submit" disabled={branchBusy || !newBranch.trim()}>
                  {t("git.createBranch")}
                </button>
              </form>
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
  changesOpen,
  onOpenChanges,
  variant = "default",
}: {
  status: GitStatusDto;
  branchBusy: boolean;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
  changesOpen?: boolean;
  onOpenChanges?: () => void;
  variant?: "default" | "metaChip" | "composerFooter" | "composerMeta" | "composerSubtle";
}) {
  const t = useT();
  const premium = variant === "composerFooter";
  const branchVariant =
    variant === "metaChip"
      ? "metaChip"
      : variant === "composerMeta"
        ? "composerMeta"
        : variant === "composerSubtle"
          ? "composerSubtle"
          : "default";

  return (
    <div
      className={`${styles.bar}${variant === "metaChip" ? ` ${styles.barMetaChip}` : ""}${
        variant === "composerMeta" ? ` ${styles.barComposerMeta}` : ""
      }${variant === "composerFooter" ? ` ${styles.barComposerFooter}` : ""}${
        variant === "composerSubtle" ? ` ${styles.barComposerSubtle}` : ""
      }`}
    >
      <GitBranchSwitcher
        status={status}
        branchBusy={branchBusy}
        onCheckout={onCheckout}
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
          iconOnly={variant === "metaChip" || variant === "composerMeta"}
          premium={premium}
        />
      ) : null}
    </div>
  );
}
