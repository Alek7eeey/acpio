import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { GitCommitDto, GitStatusDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { assignCommitDepths, dedupeCommitRefs, gitLaneColor } from "../lib/gitCommitGraph";
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
  branches,
  branchFilter,
  onToggleBranch,
  onClearBranchFilter,
  hasMore,
  loadingMore,
  onLoadMore,
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
  busy: boolean;
  selectedHash: string | null;
  wipSelected: boolean;
  /** Branches the filter offers: local names first, then remote ones. */
  branches: string[];
  /** Picked branches; empty means every branch. */
  branchFilter: string[];
  onToggleBranch: (branch: string) => void;
  onClearBranchFilter: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
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
  /** The list draws its own graph over everything loaded, pages included. */
  const rows = useMemo(() => assignCommitDepths(commits), [commits]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const filterBtnRef = useRef<HTMLButtonElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterStyle, setFilterStyle] = useState<CSSProperties>({});

  /** The branch list is long: the picker searches it instead of scrolling 250 chips. */
  const filterMatches = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (!query) return branches;
    return branches.filter((branch) => branch.toLowerCase().includes(query));
  }, [branches, filterQuery]);

  useLayoutEffect(() => {
    if (!filterOpen || !filterBtnRef.current) return;
    const place = () => {
      const button = filterBtnRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const gap = 6;
      const margin = 10;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openAbove = spaceBelow < 240 && spaceAbove > spaceBelow;
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
      setFilterStyle({
        position: "fixed",
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(180, Math.min(340, (openAbove ? spaceAbove : spaceBelow) - gap)),
        ...(openAbove
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (filterBtnRef.current?.contains(target)) return;
      if (filterMenuRef.current?.contains(target)) return;
      setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

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

  /**
   * A new filter is a new list: start it from the newest commit instead of
   * leaving the reader at the bottom of a list that no longer exists.
   */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [branchFilter]);

  /**
   * Scrolling into the list's end asks for the next page. The observer watches a
   * sentinel under the last row, so a short page still loads without a click, and
   * a tall window does not need a scroll event to get going.
   */
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = moreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { root: scrollRef.current, rootMargin: "240px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, commits.length]);

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

  return (
    <div className={styles.wrap}>
      <div className={styles.filterBar}>
        <button
          ref={filterBtnRef}
          type="button"
          className={`${styles.filterBtn}${branchFilter.length > 0 ? ` ${styles.filterBtnActive}` : ""}`}
          aria-haspopup="listbox"
          aria-expanded={filterOpen}
          aria-label={t("git.historyFilterLabel")}
          title={t("git.historyFilterLabel")}
          onClick={() => {
            setFilterQuery("");
            setFilterOpen((open) => !open);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 6h16M7 12h10M10 18h4"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          <span className={styles.filterLabel}>
            {branchFilter.length === 0
              ? t("git.historyBranchesAll")
              : t("git.historyBranchesPicked", { count: branchFilter.length })}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {branchFilter.length > 0 ? (
          <button
            type="button"
            className={styles.filterClear}
            onClick={onClearBranchFilter}
            aria-label={t("git.historyAllBranches")}
            title={t("git.historyAllBranches")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      <div className={styles.scroll} ref={scrollRef}>
        {loading && rows.length === 0 ? (
          <div className={styles.empty}>{t("common.loading")}</div>
        ) : null}
        {!loading && rows.length === 0 && !status?.dirty ? (
          <div className={styles.empty}>
            {branchFilter.length > 0 ? t("git.historyEmptyFilter") : t("git.noCommits")}
          </div>
        ) : null}
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

        {rows.map((commit, index) => {
          const active = selectedHash === commit.hash;
          const first = !status?.dirty && index === 0;
          const last = index === rows.length - 1;
          return (
            <button
              key={commit.hash}
              type="button"
              className={`${styles.row}${active ? ` ${styles.rowActive}` : ""}`}
              onClick={() => onSelectCommit(commit.hash)}
              onContextMenu={(e) => openCommitMenu(e, commit)}
              title={commit.subject}
            >
              <CommitRail depth={commit.depth ?? 0} merge={commit.merge} first={first} last={last} />
              <span className={styles.main}>
                <span className={styles.topLine}>
                  <BranchPills
                    refs={commit.refs}
                    depth={commit.depth ?? 0}
                    currentBranch={status?.branch}
                  />
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

        {hasMore || loadingMore ? (
          <div className={styles.more} ref={moreRef}>
            <button type="button" disabled={loadingMore} onClick={onLoadMore}>
              {loadingMore ? t("common.loading") : t("git.historyLoadMore")}
            </button>
          </div>
        ) : null}
      </div>

      {filterOpen
        ? createPortal(
            <div
              ref={filterMenuRef}
              className={styles.filterMenu}
              style={filterStyle}
              role="listbox"
              aria-multiselectable
              aria-label={t("git.historyFilterLabel")}
            >
              <input
                className={styles.filterSearch}
                value={filterQuery}
                autoFocus
                placeholder={t("git.historyFilterSearch")}
                aria-label={t("git.historyFilterSearch")}
                onChange={(e) => setFilterQuery(e.target.value)}
              />
              <button
                type="button"
                role="option"
                aria-selected={branchFilter.length === 0}
                className={`${styles.filterOption}${branchFilter.length === 0 ? ` ${styles.filterOptionOn}` : ""}`}
                onClick={onClearBranchFilter}
              >
                <span className={styles.filterTick} aria-hidden>
                  {branchFilter.length === 0 ? "✓" : ""}
                </span>
                <span className={styles.filterName}>{t("git.historyAllBranches")}</span>
              </button>
              <div className={styles.filterList}>
                {filterMatches.map((branch) => {
                  const on = branchFilter.includes(branch);
                  return (
                    <button
                      key={branch}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`${styles.filterOption}${on ? ` ${styles.filterOptionOn}` : ""}`}
                      title={branch}
                      onClick={() => onToggleBranch(branch)}
                    >
                      <span className={styles.filterTick} aria-hidden>
                        {on ? "✓" : ""}
                      </span>
                      <span className={styles.filterName}>{branch}</span>
                    </button>
                  );
                })}
                {filterMatches.length === 0 ? (
                  <div className={styles.filterNoMatch}>{t("git.historyFilterNoMatch")}</div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

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
