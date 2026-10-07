import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { GitStatusDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { useFixedMenuPlacement } from "../lib/menuPosition";
import { showToast } from "../lib/toast";
import type { GitBranchDeleteOutcome } from "./ComposerGitBar";
import styles from "./GitBranchesPane.module.css";

/** One level of the branch tree: folders hold folders and branches. */
type BranchFolder = {
  name: string;
  path: string;
  folders: BranchFolder[];
  /** Full refs whose last segment sits at this level. */
  branches: string[];
};

/** The row a context menu was opened on. */
type BranchMenuState = { x: number; y: number; ref: string; remote: boolean };

/**
 * Branch names as a tree: `feature/10.0/bb1` nests one folder per segment. A
 * name can be both — `release` and `release/10.0` may exist together — and the
 * branch keeps its own row at the level its folder sits on.
 */
function buildBranchTree(branches: string[]): BranchFolder {
  const root: BranchFolder = { name: "", path: "", folders: [], branches: [] };
  for (const ref of branches) {
    const parts = ref.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.find((folder) => folder.name === part);
      if (!next) {
        next = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          folders: [],
          branches: [],
        };
        node.folders.push(next);
      }
      node = next;
    }
    if (!node.branches.includes(ref)) node.branches.push(ref);
  }
  return root;
}

/** What the row shows: the last segment of the ref, which the folders carry. */
function branchLabel(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] || ref;
}

/**
 * The branch board, split the way the repository itself is: local branches and
 * remote-tracking refs, each folded into folders by the `/` of their names.
 *
 * A branch name is the merge command — clicking the branch that would supply
 * the commits merges it into the checked-out one — and a right click opens the
 * menu of everything else: switching, branching off, renaming, deleting a local
 * branch, and, on a remote one, branching it out locally or copying its name.
 */
export function GitBranchesPane({
  status,
  busy,
  branches,
  refs,
  onSwitch,
  onCreate,
  onMerge,
  onRenameBranch,
  onDeleteBranch,
}: {
  status: GitStatusDto | null;
  /** A git command is in flight: every control of the pane waits for it. */
  busy: boolean;
  /** Local branches: the "Local" group and the rows the app can switch to. */
  branches: string[];
  /** Local names first, then remote ones — what "Remote" holds beyond the local. */
  refs: string[];
  onSwitch: (branch: string) => void;
  onCreate: (branch: string, start: string) => void;
  onMerge: (from: string, into: string) => void;
  onRenameBranch: (branch: string, next: string) => void;
  onDeleteBranch: (branch: string, opts?: { force?: boolean }) => Promise<GitBranchDeleteOutcome>;
}) {
  const t = useT();
  const current = status?.branch ?? "";
  /** Folded folders and groups, by their key — everything starts expanded. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<BranchMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useFixedMenuPlacement(menu, menuRef);

  const localTree = useMemo(() => buildBranchTree(branches), [branches]);
  const remoteBranches = useMemo(() => {
    const local = new Set(branches);
    return refs.filter((ref) => !local.has(ref));
  }, [refs, branches]);
  const remoteTree = useMemo(() => buildBranchTree(remoteBranches), [remoteBranches]);

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
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

  const toggleFolder = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const toggleGroup = (group: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const openMenu = (event: ReactMouseEvent, ref: string, remote: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, ref, remote });
  };

  /** Clicking the branch that supplies the commits merges it into the current one. */
  const mergeIntoCurrent = (ref: string) => {
    if (busy || !current || ref === current) return;
    if (!window.confirm(t("git.mergeIntoConfirm", { from: ref, into: current }))) return;
    onMerge(ref, current);
  };

  const createFrom = (ref: string) => {
    if (busy) return;
    const name = window.prompt(t("git.newBranchPlaceholder"));
    if (name?.trim()) onCreate(name.trim(), ref);
  };

  const renameBranch = (ref: string) => {
    if (busy) return;
    const next = window.prompt(t("git.branchRenamePrompt", { branch: ref }), ref);
    if (!next?.trim() || next.trim() === ref) return;
    onRenameBranch(ref, next.trim());
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

  const copyBranchName = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
      showToast(t("common.copied"), { tone: "success" });
    } catch {
      /* the clipboard is not available: nothing to say about a copy that did not happen */
    }
  };

  const branchRow = (ref: string, depth: number, remote: boolean) => {
    const isCurrent = ref === current;
    return (
      <div
        key={ref}
        className={`${styles.row}${isCurrent ? ` ${styles.rowCurrent}` : ""}`}
        style={{ "--branch-depth": depth } as CSSProperties}
        onContextMenu={(event) => openMenu(event, ref, remote)}
      >
        <span className={styles.check} aria-hidden>
          {isCurrent ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="m4.5 12.5 5 5 10-11"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
        <span className={styles.refIcon} aria-hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <circle cx="7" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="7" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="17" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M7 8.2v7.6M9.2 6.8c3 .5 5.6 1.6 5.6 5.2"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <button
          type="button"
          className={styles.nameBtn}
          disabled={busy || isCurrent || !current}
          title={
            isCurrent ? ref : t("git.branchMergeHint", { branch: ref, target: current })
          }
          onClick={() => mergeIntoCurrent(ref)}
        >
          {branchLabel(ref)}
        </button>
        {isCurrent ? <span className={styles.badge}>{t("git.branchCurrent")}</span> : null}
        <span className={styles.rowActions}>
          {remote ? null : (
            <button
              type="button"
              className={styles.iconBtn}
              disabled={busy || isCurrent}
              title={t("git.branchSwitch")}
              aria-label={t("git.branchSwitchLabel", { branch: ref })}
              onClick={() => onSwitch(ref)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 12h11M11.5 7.5 16 12l-4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            disabled={busy}
            title={t("git.branchCreateFrom")}
            aria-label={t("git.branchCreateFromLabel", { branch: ref })}
            onClick={() => createFrom(ref)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>
    );
  };

  const nodes = (folder: BranchFolder, key: string, depth: number, remote: boolean): ReactNode[] => {
    const rows: ReactNode[] = folder.folders.map((child) => {
      const childKey = `${key}/${child.name}`;
      const isCollapsed = collapsed[childKey] ?? false;
      return (
        <div key={childKey}>
          <button
            type="button"
            className={styles.folder}
            style={{ "--branch-depth": depth } as CSSProperties}
            aria-expanded={!isCollapsed}
            title={child.name}
            onClick={() => toggleFolder(childKey)}
          >
            <span className={styles.chevron} aria-hidden>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d={isCollapsed ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6"}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.folderIcon} aria-hidden>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className={styles.folderName}>{child.name}</span>
          </button>
          {isCollapsed ? null : nodes(child, childKey, depth + 1, remote)}
        </div>
      );
    });
    rows.push(...folder.branches.map((ref) => branchRow(ref, depth, remote)));
    return rows;
  };

  const group = (id: "local" | "remote", title: string, tree: BranchFolder, list: string[]) => {
    const isCollapsed = collapsedGroups[id] ?? false;
    return (
      <div className={styles.group} key={id}>
        <button
          type="button"
          className={styles.groupHead}
          aria-expanded={!isCollapsed}
          onClick={() => toggleGroup(id)}
        >
          <span className={styles.chevron} aria-hidden>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d={isCollapsed ? "M9 6l6 6-6 6" : "M6 9l6 6 6-6"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className={styles.groupIcon} aria-hidden>
            {id === "local" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="4" y="5.5" width="16" height="11" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
                <path d="M2.5 18.5h19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5-3.6-8.5S9.6 5.8 12 3.5Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
            )}
          </span>
          <span className={styles.groupTitle}>{title}</span>
          <span className={styles.groupCount}>{list.length}</span>
        </button>
        {isCollapsed ? null : (
          <div className={styles.groupBody}>
            {list.length === 0 ? (
              <div className={styles.empty}>{t("git.branchesEmpty")}</div>
            ) : (
              nodes(tree, id, 0, id === "remote")
            )}
          </div>
        )}
      </div>
    );
  };

  const menuBranch = menu?.ref ?? "";
  const menuIsCurrent = menuBranch === current;

  return (
    <div className={styles.wrap}>
      <div className={styles.scroll}>
        {group("local", t("git.branchesLocal"), localTree, branches)}
        {group("remote", t("git.branchesRemote"), remoteTree, remoteBranches)}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={menuStyle ?? undefined}
          role="menu"
          aria-label={t("git.branchActions")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy || menuIsCurrent || !current}
            onClick={() => {
              const ref = menuBranch;
              closeMenu();
              mergeIntoCurrent(ref);
            }}
          >
            {t("git.branchMergeHint", { branch: menuBranch, target: current })}
          </button>
          {menu.remote ? null : (
            <button
              type="button"
              role="menuitem"
              disabled={busy || menuIsCurrent}
              onClick={() => {
                const ref = menuBranch;
                closeMenu();
                onSwitch(ref);
              }}
            >
              {t("git.branchSwitch")}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              const ref = menuBranch;
              closeMenu();
              createFrom(ref);
            }}
          >
            {t("git.branchCreateFrom")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              const ref = menuBranch;
              closeMenu();
              void copyBranchName(ref);
            }}
          >
            {t("git.branchCopyName")}
          </button>
          {menu.remote ? null : (
            <>
              <div className={styles.contextMenuDivider} aria-hidden />
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  const ref = menuBranch;
                  closeMenu();
                  renameBranch(ref);
                }}
              >
                {t("git.branchRename")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy || Boolean(status?.protectedBranches.includes(menuBranch))}
                onClick={() => {
                  const ref = menuBranch;
                  closeMenu();
                  removeBranch(ref);
                }}
              >
                {t("git.deleteBranch")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
