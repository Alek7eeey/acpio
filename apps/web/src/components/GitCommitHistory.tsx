import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { GitCommitDto, GitStatusDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { dedupeCommitRefs, gitLaneColor } from "../lib/gitCommitGraph";
import { useFixedMenuPlacement } from "../lib/menuPosition";
import styles from "./GitCommitHistory.module.css";

type CommitMenuState = { x: number; y: number; commit: GitCommitDto };

function refMeta(ref: string, currentBranch?: string) {
  const remote = ref.includes("/");
  const short = ref.replace(/^origin\//, "");
  const current =
    currentBranch !== undefined &&
    (ref === currentBranch || short === currentBranch || ref.endsWith(`/${currentBranch}`));
  return { ref, short, remote, current };
}

function formatShortDate(iso: string) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function BranchPills({
  refs,
  depth,
  currentBranch,
}: {
  refs: string[];
  depth: number;
  currentBranch?: string;
}) {
  if (refs.length === 0) return null;
  const displayRefs = dedupeCommitRefs(refs, currentBranch);
  const color = gitLaneColor(depth);
  return (
    <>
      {displayRefs.slice(0, 3).map((ref) => {
        const meta = refMeta(ref, currentBranch);
        return (
          <span
            key={ref}
            className={`${styles.branchPill}${meta.current ? ` ${styles.branchPillCurrent}` : ""}`}
            style={{ "--pill-color": color } as CSSProperties}
            title={ref}
          >
            {meta.current ? "● " : ""}
            {meta.short}
          </span>
        );
      })}
    </>
  );
}

function CommitRail({
  depth,
  merge,
  first,
  last,
}: {
  depth: number;
  merge: boolean;
  first: boolean;
  last: boolean;
}) {
  const indent = Math.min(Math.max(depth, 0), 4) * 8;
  const color = gitLaneColor(depth);
  return (
    <span
      className={`${styles.rail}${first ? ` ${styles.railFirst}` : ""}${last ? ` ${styles.railLast}` : ""}`}
      style={
        {
          "--rail-color": color,
          "--rail-indent": `${indent}px`,
        } as CSSProperties
      }
      aria-hidden
    >
      <span className={merge ? styles.railMerge : styles.railDot} />
    </span>
  );
}

async function copyCommitHash(commit: GitCommitDto) {
  await navigator.clipboard.writeText(commit.hash);
}

export function GitCommitHistory({
  commits,
  status,
  loading,
  busy,
  selectedHash,
  wipSelected,
  onSelectCommit,
  onSelectWip,
  onRevertCommit,
  onCherryPickCommit,
  onCreateBranchAt,
  onCreateTagAt,
  onCheckoutCommit,
}: {
  commits: GitCommitDto[];
  status: GitStatusDto | null;
  loading: boolean;
  busy?: boolean;
  selectedHash: string | null;
  wipSelected: boolean;
  onSelectCommit: (hash: string) => void;
  onSelectWip: () => void;
  onRevertCommit: (hash: string) => void;
  onCherryPickCommit: (hash: string) => void;
  onCreateBranchAt: (hash: string, branch: string) => void;
  onCreateTagAt: (hash: string, tag: string) => void;
  onCheckoutCommit: (hash: string) => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<CommitMenuState | null>(null);
  const menuStyle = useFixedMenuPlacement(menu, menuRef);

  const openCommitMenu = useCallback(
    (e: ReactMouseEvent, commit: GitCommitDto) => {
      e.preventDefault();
      e.stopPropagation();
      onSelectCommit(commit.hash);
      setMenu({ x: e.clientX, y: e.clientY, commit });
    },
    [onSelectCommit],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeMenu, menu]);

  const handleCopyCommit = useCallback(async () => {
    if (!menu) return;
    try {
      await copyCommitHash(menu.commit);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    } finally {
      closeMenu();
    }
  }, [closeMenu, menu, t]);

  const handleCopyShortHash = useCallback(async () => {
    if (!menu) return;
    try {
      await navigator.clipboard.writeText(menu.commit.shortHash);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    } finally {
      closeMenu();
    }
  }, [closeMenu, menu, t]);

  const handleCopyCommitSubject = useCallback(async () => {
    if (!menu) return;
    try {
      await navigator.clipboard.writeText(menu.commit.subject);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    } finally {
      closeMenu();
    }
  }, [closeMenu, menu, t]);

  if (loading) {
    return <div className={styles.empty}>{t("common.loading")}</div>;
  }

  if (commits.length === 0 && !status?.dirty) {
    return <div className={styles.empty}>{t("git.noCommits")}</div>;
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>{t("git.tabHistory")}</div>
      <div className={styles.scroll}>
        {status?.dirty ? (
          <button
            type="button"
            className={`${styles.row}${wipSelected ? ` ${styles.rowActive}` : ""}`}
            onClick={onSelectWip}
          >
            <span className={`${styles.rail} ${styles.railWip}`} aria-hidden>
              <span className={styles.railDot} />
            </span>
            <span className={styles.main}>
              <span className={styles.topLine}>
                <span className={styles.wipBadge}>{t("git.wip")}</span>
                <span className={styles.subject}>{t("git.wipHint")}</span>
              </span>
              <span className={styles.meta}>
                {status.files.length} {t("git.changedFiles", { count: status.files.length })}
              </span>
            </span>
          </button>
        ) : null}

        {commits.map((commit, index) => {
          const active = selectedHash === commit.hash;
          const first = !status?.dirty && index === 0;
          const last = index === commits.length - 1;
          return (
            <button
              key={commit.hash}
              type="button"
              className={`${styles.row}${active ? ` ${styles.rowActive}` : ""}`}
              onClick={() => onSelectCommit(commit.hash)}
              onContextMenu={(e) => openCommitMenu(e, commit)}
              title={commit.subject}
            >
              <CommitRail depth={commit.depth} merge={commit.merge} first={first} last={last} />
              <span className={styles.main}>
                <span className={styles.topLine}>
                  <BranchPills refs={commit.refs} depth={commit.depth} currentBranch={status?.branch} />
                  <span className={styles.subject}>{commit.subject || commit.shortHash}</span>
                </span>
                <span className={styles.meta}>
                  <span className={styles.hash}>{commit.shortHash}</span>
                  <span className={styles.metaSep} aria-hidden>
                    ·
                  </span>
                  <span className={styles.author}>{commit.author}</span>
                  {commit.date ? (
                    <>
                      <span className={styles.metaSep} aria-hidden>
                        ·
                      </span>
                      <span className={styles.date}>{formatShortDate(commit.date)}</span>
                    </>
                  ) : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={menuStyle ?? undefined}
          role="menu"
          aria-label={t("git.commitMenu")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              closeMenu();
              onSelectCommit(menu.commit.hash);
            }}
          >
            {t("git.viewCommit")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              closeMenu();
              onCheckoutCommit(menu.commit.hash);
            }}
          >
            {t("git.checkoutCommit")}
          </button>
          <div className={styles.contextMenuDivider} aria-hidden />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              closeMenu();
              onRevertCommit(menu.commit.hash);
            }}
          >
            {t("git.revertCommit")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              closeMenu();
              onCherryPickCommit(menu.commit.hash);
            }}
          >
            {t("git.cherryPickCommit")}
          </button>
          <div className={styles.contextMenuDivider} aria-hidden />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              const hash = menu.commit.hash;
              closeMenu();
              const branch = window.prompt(t("git.newBranchPlaceholder"));
              if (branch?.trim()) onCreateBranchAt(hash, branch.trim());
            }}
          >
            {t("git.createBranchHere")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              const hash = menu.commit.hash;
              closeMenu();
              const tag = window.prompt(t("git.newTagPlaceholder"));
              if (tag?.trim()) onCreateTagAt(hash, tag.trim());
            }}
          >
            {t("git.createTagHere")}
          </button>
          <div className={styles.contextMenuDivider} aria-hidden />
          <button type="button" role="menuitem" onClick={() => void handleCopyCommit()}>
            {t("git.copyCommit")}
          </button>
          <button type="button" role="menuitem" onClick={() => void handleCopyShortHash()}>
            {t("git.copyShortHash")}
          </button>
          <button type="button" role="menuitem" onClick={() => void handleCopyCommitSubject()}>
            {t("git.copyCommitSubject")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
