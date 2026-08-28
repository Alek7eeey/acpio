import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { GitChangedFileDto, GitCommitDetailDto, GitCommitFileDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { joinRepoPath, normalizeGitPath, toRepoAbsolutePath } from "../lib/gitFileTree";
import { api } from "../lib/api";
import { GitDiffStats } from "./GitDiffStats";
import { showToast } from "../lib/toast";
import styles from "./GitCommitDetail.module.css";

const DESCRIPTION_HEIGHT_KEY = "acpio.gitCommitDetailHeaderHeight.v1";
const DESCRIPTION_HEIGHT_DEFAULT = 168;
const DESCRIPTION_HEIGHT_MIN = 96;
const DESCRIPTION_HEIGHT_MAX = 440;

function readDescriptionHeight() {
  try {
    const raw = localStorage.getItem(DESCRIPTION_HEIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) {
      return Math.min(DESCRIPTION_HEIGHT_MAX, Math.max(DESCRIPTION_HEIGHT_MIN, n));
    }
  } catch {
    /* ignore */
  }
  return DESCRIPTION_HEIGHT_DEFAULT;
}

function formatCommitDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} @ ${date.getHours()}:${pad(date.getMinutes())}`;
}

function authorInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[1]!.slice(0, 1)}`.toUpperCase();
}

function revealPath(root: string, rel: string, deleted: boolean) {
  const abs = joinRepoPath(root, rel);
  if (!deleted) return abs;
  const slash = abs.lastIndexOf("/");
  return slash > 0 ? abs.slice(0, slash) : abs;
}

type FileMenuState = { x: number; y: number; path: string; deleted: boolean };

function FileStatusIcon({ status }: { status: GitCommitFileDto["status"] }) {
  if (status === "added" || status === "copied") {
    return (
      <span className={`${styles.fileStatusIcon} ${styles.fileStatusAdded}`} aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (status === "deleted") {
    return (
      <span className={`${styles.fileStatusIcon} ${styles.fileStatusDeleted}`} aria-hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className={`${styles.fileStatusIcon} ${styles.fileStatusModified}`} aria-hidden>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path
          d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function CommitFileRow({
  file,
  active,
  onSelect,
  onContextMenu,
}: {
  file: GitCommitFileDto;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const path = normalizeGitPath(file.path);
  const label = file.oldPath ? `${normalizeGitPath(file.oldPath)} → ${path}` : path;
  return (
    <button
      type="button"
      className={`${styles.fileRow}${active ? ` ${styles.fileRowActive}` : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={label}
    >
      <FileStatusIcon status={file.status} />
      <span className={styles.filePath}>{label}</span>
      {(file.additions > 0 || file.deletions > 0) && (
        <GitDiffStats additions={file.additions} deletions={file.deletions} className={styles.fileStats} />
      )}
    </button>
  );
}

function WipFileRow({
  file,
  active,
  onSelect,
  onContextMenu,
}: {
  file: GitChangedFileDto;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const path = normalizeGitPath(file.path);
  return (
    <button
      type="button"
      className={`${styles.fileRow}${active ? ` ${styles.fileRowActive}` : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={path}
    >
      <FileStatusIcon status={file.unstaged || !file.staged ? "modified" : "added"} />
      <span className={styles.filePath}>{path}</span>
      {(file.additions > 0 || file.deletions > 0) && (
        <GitDiffStats additions={file.additions} deletions={file.deletions} className={styles.fileStats} />
      )}
    </button>
  );
}

export function GitCommitDetail({
  loading,
  detail,
  wipFiles,
  repoRoot,
  selectedFilePath,
  onSelectFile,
  onSelectParent,
  onBlameFile,
  wipMode = false,
}: {
  loading?: boolean;
  detail: GitCommitDetailDto | null;
  wipFiles?: GitChangedFileDto[];
  repoRoot?: string;
  selectedFilePath?: string | null;
  onSelectFile: (path: string) => void;
  onSelectParent?: (hash: string) => void;
  onBlameFile?: (path: string) => void;
  wipMode?: boolean;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [sortDesc, setSortDesc] = useState(false);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  const [descriptionHeight, setDescriptionHeight] = useState(readDescriptionHeight);
  const [resizing, setResizing] = useState(false);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const closeFileMenu = useCallback(() => setFileMenu(null), []);

  const openFileMenu = useCallback((path: string, deleted: boolean, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileMenu({ x: e.clientX, y: e.clientY, path, deleted });
  }, []);

  useEffect(() => {
    if (!fileMenu) return;
    const onPointerDown = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      closeFileMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFileMenu();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeFileMenu, fileMenu]);

  useEffect(() => {
    try {
      localStorage.setItem(DESCRIPTION_HEIGHT_KEY, String(descriptionHeight));
    } catch {
      /* ignore */
    }
  }, [descriptionHeight]);

  const onDescriptionResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeDragRef.current = { startY: e.clientY, startHeight: descriptionHeight };
      setResizing(true);
    },
    [descriptionHeight],
  );

  const onDescriptionResizeDoubleClick = useCallback(() => {
    setDescriptionHeight(DESCRIPTION_HEIGHT_DEFAULT);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const next = drag.startHeight + (e.clientY - drag.startY);
      setDescriptionHeight(Math.min(DESCRIPTION_HEIGHT_MAX, Math.max(DESCRIPTION_HEIGHT_MIN, next)));
    };
    const onUp = () => {
      resizeDragRef.current = null;
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [resizing]);

  const handleCopyRelativePath = useCallback(async () => {
    if (!fileMenu) return;
    closeFileMenu();
    try {
      await navigator.clipboard.writeText(normalizeGitPath(fileMenu.path));
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [closeFileMenu, fileMenu, t]);

  const handleCopyPath = useCallback(async () => {
    if (!fileMenu) return;
    const path = repoRoot
      ? toRepoAbsolutePath(repoRoot, fileMenu.path)
      : normalizeGitPath(fileMenu.path);
    closeFileMenu();
    try {
      await navigator.clipboard.writeText(path);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [closeFileMenu, fileMenu, repoRoot, t]);

  const handleOpenFile = useCallback(async () => {
    if (!fileMenu || !repoRoot || fileMenu.deleted) return;
    const target = toRepoAbsolutePath(repoRoot, fileMenu.path);
    closeFileMenu();
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.openFileFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [closeFileMenu, fileMenu, repoRoot, t]);

  const handleShowInFolder = useCallback(async () => {
    if (!fileMenu || !repoRoot) return;
    const target = revealPath(repoRoot, fileMenu.path, fileMenu.deleted);
    closeFileMenu();
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.showInFolderFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [closeFileMenu, fileMenu, repoRoot, t]);

  const wipTotals = useMemo(() => {
    if (!wipFiles?.length) return { additions: 0, deletions: 0 };
    return wipFiles.reduce(
      (acc, file) => ({
        additions: acc.additions + file.additions,
        deletions: acc.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
  }, [wipFiles]);

  const commitFiles = useMemo(() => {
    if (!detail) return [];
    const next = [...detail.files];
    next.sort((a, b) => {
      const cmp = a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
      return sortDesc ? -cmp : cmp;
    });
    return next;
  }, [detail, sortDesc]);

  const wipList = useMemo(() => {
    if (!wipFiles) return [];
    const next = [...wipFiles];
    next.sort((a, b) => {
      const cmp = a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
      return sortDesc ? -cmp : cmp;
    });
    return next;
  }, [sortDesc, wipFiles]);

  if (loading) {
    return <div className={styles.loading}>{t("common.loading")}</div>;
  }

  if (!detail && !wipFiles?.length) {
    return <div className={styles.empty}>{t("git.pickCommit")}</div>;
  }

  const copyHash = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.hash);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className={`${styles.wrap}${resizing ? ` ${styles.wrapResizing}` : ""}`}>
      <div className={styles.descriptionPane} style={{ height: `${descriptionHeight}px` }}>
        {detail ? (
          <div className={styles.header}>
            <div className={styles.headerTop}>
              <div>
                <p className={styles.subject}>{detail.subject}</p>
                {detail.body ? <p className={styles.body}>{detail.body}</p> : null}
              </div>
              <div className={styles.hashRow}>
                <span className={styles.hashLabel}>{t("git.commitLabel")}</span>
                <span className={styles.hashValue}>{detail.shortHash}</span>
                <button type="button" className={styles.copyBtn} onClick={() => void copyHash()} title={t("git.copyCommit")}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <rect x="8" y="8" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 16V6a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.authorBlock}>
                <span className={styles.avatar} aria-hidden>
                  {authorInitials(detail.author)}
                </span>
                <span className={styles.authorName}>{detail.author}</span>
                <span className={styles.authored}>
                  {t("git.authoredAt", { date: formatCommitDate(detail.date) })}
                </span>
              </span>
              {detail.parents[0] ? (
                <span className={styles.parentBlock}>
                  <span>{t("git.parentLabel")}</span>
                  <button
                    type="button"
                    className={styles.parentBtn}
                    onClick={() => onSelectParent?.(detail.parents[0]!)}
                    title={detail.parents[0]!}
                  >
                    {detail.parentShortHashes[0]}
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className={styles.header}>
            <p className={styles.subject}>{t("git.wipHint")}</p>
          </div>
        )}
      </div>

      <div
        className={styles.detailSplitter}
        onPointerDown={onDescriptionResizeDown}
        onDoubleClick={onDescriptionResizeDoubleClick}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("git.resizeCommitDescription")}
        title={t("git.resizeCommitDescription")}
      />

      <div className={styles.filesPane}>
      <div className={styles.toolbar}>
        <div className={styles.stats}>
          {detail ? (
            <>
              {(detail.additions > 0 || detail.deletions > 0) && (
                <GitDiffStats additions={detail.additions} deletions={detail.deletions} className={styles.diffTotals} />
              )}
              {detail.modifiedCount > 0 ? (
                <span className={`${styles.statItem} ${styles.statModified}`}>
                  {t("git.commitModifiedCount", { count: detail.modifiedCount })}
                </span>
              ) : null}
              {detail.addedCount > 0 ? (
                <span className={`${styles.statItem} ${styles.statAdded}`}>
                  {t("git.commitAddedCount", { count: detail.addedCount })}
                </span>
              ) : null}
              {detail.deletedCount > 0 ? (
                <span className={`${styles.statItem} ${styles.statDeleted}`}>
                  {t("git.commitDeletedCount", { count: detail.deletedCount })}
                </span>
              ) : null}
            </>
          ) : (
            <>
              {(wipTotals.additions > 0 || wipTotals.deletions > 0) && (
                <GitDiffStats
                  additions={wipTotals.additions}
                  deletions={wipTotals.deletions}
                  className={styles.diffTotals}
                />
              )}
              <span className={styles.statItem}>{t("git.changedFiles", { count: wipFiles?.length ?? 0 })}</span>
            </>
          )}
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setSortDesc((value) => !value)}
            title={t("git.sortFiles")}
            aria-label={t("git.sortFiles")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M8 6h12M8 12h8M8 18h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M5 6v12M5 6l-2 2M5 6l2 2M5 18l-2-2M5 18l2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles.fileList}>
        {detail
          ? commitFiles.map((file) => (
              <CommitFileRow
                key={file.path}
                file={file}
                active={selectedFilePath === file.path}
                onSelect={() => onSelectFile(file.path)}
                onContextMenu={(e) => openFileMenu(file.path, file.status === "deleted", e)}
              />
            ))
          : wipList.map((file) => (
              <WipFileRow
                key={file.path}
                file={file}
                active={selectedFilePath === file.path}
                onSelect={() => onSelectFile(file.path)}
                onContextMenu={(e) =>
                  openFileMenu(
                    file.path,
                    file.index === "D" || file.worktree === "D",
                    e,
                  )
                }
              />
            ))}
      </div>
      </div>

      {fileMenu ? (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={{ left: fileMenu.x, top: fileMenu.y }}
          role="menu"
          aria-label={t("git.fileMenu")}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeFileMenu();
              onSelectFile(fileMenu.path);
            }}
          >
            {t("git.viewDiff")}
          </button>
          <div className={styles.contextMenuDivider} aria-hidden />
          <button type="button" role="menuitem" onClick={() => void handleCopyRelativePath()}>
            {t("git.copyRelativePath")}
          </button>
          <button type="button" role="menuitem" onClick={() => void handleCopyPath()}>
            {t("git.copyFilePath")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!repoRoot || fileMenu.deleted}
            onClick={() => void handleOpenFile()}
          >
            {t("git.openFile")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!repoRoot}
            onClick={() => void handleShowInFolder()}
          >
            {t("git.showInFolder")}
          </button>
          {wipMode && onBlameFile && !fileMenu.deleted ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeFileMenu();
                void onBlameFile(fileMenu.path);
              }}
            >
              {t("git.fileBlame")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
