import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { GitChangedFileDto, GitCommitDto, GitCommitFileDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import {
  buildGitFileTreeRows,
  joinRepoPath,
  normalizeGitPath,
  sortGitFiles,
  toRepoAbsolutePath,
} from "../lib/gitFileTree";
import { gitStatusBadge, isGitConflictFile, isUntrackedGitFile } from "../lib/gitUi";
import { useFixedMenuPlacement } from "../lib/menuPosition";
import { GitDiffStats } from "./GitDiffStats";
import { showToast } from "../lib/toast";
import styles from "./GitChangesCommitPane.module.css";

const COMMIT_HEIGHT_KEY = "acpio.gitCommitSectionHeight.v1";
const COMMIT_HEIGHT_DEFAULT = 168;
const COMMIT_HEIGHT_MIN = 120;
const COMMIT_HEIGHT_MAX = 360;
export const CHANGES_VIEW_KEY = "acpio.gitChangesView.v1";
const DND_MIME = "application/x-acpio-git-paths";

type StageZone = "staged" | "unstaged";
/** Changed files as one row per file (…/a/b.ts) or one per folder level (b → b/b.ts). */
export type ChangesView = "list" | "tree";
type FileMenuState =
  | { kind: "file"; x: number; y: number; file: GitChangedFileDto }
  | { kind: "dir"; x: number; y: number; path: string };

/** The navigator header owns the switch; the rows here only read the answer. */
export function readChangesView(): ChangesView {
  try {
    return localStorage.getItem(CHANGES_VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

function isDeleted(file: GitChangedFileDto) {
  return file.index === "D" || file.worktree === "D";
}

function canBlame(file: GitChangedFileDto) {
  return !isUntrackedGitFile(file);
}

function revealPath(root: string, rel: string, deleted: boolean) {
  const abs = joinRepoPath(root, rel);
  if (!deleted) return abs;
  const slash = abs.lastIndexOf("/");
  return slash > 0 ? abs.slice(0, slash) : abs;
}

function resolveMenuPaths(file: GitChangedFileDto, selectedPaths: Set<string>) {
  if (selectedPaths.has(file.path) && selectedPaths.size > 1) return [...selectedPaths];
  return [file.path];
}

function readCommitHeight() {
  try {
    const raw = localStorage.getItem(COMMIT_HEIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(COMMIT_HEIGHT_MAX, Math.max(COMMIT_HEIGHT_MIN, n));
  } catch {
    /* ignore */
  }
  return COMMIT_HEIGHT_DEFAULT;
}

function parseDragPaths(e: DragEvent): string[] {
  const raw = e.dataTransfer.getData(DND_MIME);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function ChangesSection({
  title,
  count,
  collapsed,
  onToggle,
  action,
  stageZone,
  dropActive,
  onDragOverZone,
  onDragLeaveZone,
  onDropZone,
  children,
  enableDrop = true,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  stageZone: StageZone;
  dropActive: boolean;
  onDragOverZone: (zone: StageZone) => void;
  onDragLeaveZone: (zone: StageZone) => void;
  onDropZone: (zone: StageZone, e: DragEvent) => void;
  children: ReactNode;
  enableDrop?: boolean;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <button type="button" className={styles.sectionToggle} onClick={onToggle} aria-expanded={!collapsed}>
          <svg
            className={`${styles.sectionChevron}${collapsed ? ` ${styles.sectionChevronCollapsed}` : ""}`}
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={styles.sectionTitle}>
            {title} ({count})
          </span>
        </button>
        {action}
      </div>
      {!collapsed ? (
        <div
          className={`${styles.sectionBody}${enableDrop && dropActive ? ` ${styles.sectionBodyDrop}` : ""}`}
          onDragOver={
            enableDrop
              ? (e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  onDragOverZone(stageZone);
                }
              : undefined
          }
          onDragLeave={enableDrop ? () => onDragLeaveZone(stageZone) : undefined}
          onDrop={enableDrop ? (e) => onDropZone(stageZone, e) : undefined}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

function FileIcon({ file }: { file: GitChangedFileDto }) {
  const badge = gitStatusBadge(file);
  if (isGitConflictFile(file) || badge === "U") {
    return (
      <svg className={`${styles.fileIcon} ${styles.fileIconConflict}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 9v4M12 16.5h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M10.3 4.5h3.4L20 19.5H4L10.3 4.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (badge === "?" || badge === "A") {
    return (
      <svg className={`${styles.fileIcon} ${styles.fileIconAdd}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (badge === "D") {
    return (
      <svg className={`${styles.fileIcon} ${styles.fileIconDel}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className={`${styles.fileIcon} ${styles.fileIconMod}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileRow({
  file,
  zone,
  depth = 0,
  active,
  selected,
  dragging,
  busy,
  stageLabel,
  onSelect,
  onToggleStage,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: {
  file: GitChangedFileDto;
  zone: StageZone;
  depth?: number;
  active: boolean;
  selected: boolean;
  dragging: boolean;
  busy: boolean;
  stageLabel: string;
  onSelect: (e: MouseEvent) => void;
  onToggleStage: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const displayPath = normalizeGitPath(file.path);

  const handleRowDragStart = (e: DragEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(`.${styles.fileStageBtn}`)) {
      e.preventDefault();
      return;
    }
    onDragStart(e);
  };

  return (
    <div
      className={`${styles.fileRow}${active ? ` ${styles.fileRowActive}` : ""}${
        selected ? ` ${styles.fileRowSelected}` : ""
      }${isGitConflictFile(file) ? ` ${styles.fileRowConflict}` : ""}${
        dragging ? ` ${styles.fileRowDragging}` : ""
      }${busy ? "" : ` ${styles.fileRowDraggable}`}`}
      style={depth > 0 ? { ["--tree-depth" as string]: String(depth) } as CSSProperties : undefined}
      draggable={!busy}
      onDragStart={handleRowDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
    >
      <span className={styles.dragHandle} aria-hidden title={stageLabel}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="7" r="1.4" />
          <circle cx="16" cy="7" r="1.4" />
          <circle cx="8" cy="12" r="1.4" />
          <circle cx="16" cy="12" r="1.4" />
          <circle cx="8" cy="17" r="1.4" />
          <circle cx="16" cy="17" r="1.4" />
        </svg>
      </span>
      <div
        role="button"
        tabIndex={0}
        className={styles.fileBtn}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(e as unknown as MouseEvent);
          }
        }}
        title={displayPath}
      >
        <FileIcon file={file} />
        <span className={styles.fileLabel}>
          <span className={styles.fileName}>{displayPath}</span>
        </span>
        {(file.additions > 0 || file.deletions > 0) && (
          <GitDiffStats
            additions={file.additions}
            deletions={file.deletions}
            className={styles.fileStats}
          />
        )}
      </div>
      <button
        type="button"
        className={styles.fileStageBtn}
        disabled={busy}
        onClick={onToggleStage}
        title={stageLabel}
        aria-label={stageLabel}
      >
        {zone === "staged" ? "−" : "+"}
      </button>
    </div>
  );
}

/** A folder level of the changed-file tree; clicking folds the subtree. */
function DirRow({
  path: dirPath,
  name,
  count,
  depth,
  collapsed,
  onToggle,
  onContextMenu,
}: {
  path: string;
  name: string;
  count: number;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      className={styles.folderRow}
      style={{ ["--tree-depth" as string]: String(depth) } as CSSProperties}
      aria-expanded={!collapsed}
      title={dirPath}
      onClick={onToggle}
      onContextMenu={onContextMenu}
    >
      <svg
        className={`${styles.folderChevron}${collapsed ? ` ${styles.folderChevronCollapsed}` : ""}`}
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className={styles.folderIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M3.5 7.5a2 2 0 0 1 2-2h3.1l1.7 2h8.2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className={styles.folderName}>{name}</span>
      <span className={styles.folderCount}>{count}</span>
    </button>
  );
}

function FileList({
  files,
  zone,
  view,
  collapsedDirs,
  workingSelected,
  selectionPath,
  selectedPaths,
  dragPaths,
  busy,
  stageLabel,
  onToggleDir,
  onFileSelect,
  onToggleStage,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onDirContextMenu,
}: {
  files: GitChangedFileDto[];
  zone: StageZone;
  view: ChangesView;
  collapsedDirs: ReadonlySet<string>;
  workingSelected: boolean;
  selectionPath: string | null;
  selectedPaths: Set<string>;
  dragPaths: string[] | null;
  busy: boolean;
  stageLabel: string;
  onToggleDir: (path: string) => void;
  onFileSelect: (file: GitChangedFileDto, e: MouseEvent) => void;
  onToggleStage: (file: GitChangedFileDto) => void;
  onDragStart: (file: GitChangedFileDto, e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (file: GitChangedFileDto, e: MouseEvent) => void;
  onDirContextMenu: (path: string, e: MouseEvent) => void;
}) {
  /** Files under each folder of this section, for the folder badge. */
  const dirCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of files) {
      const parts = normalizeGitPath(file.path).split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }
    return counts;
  }, [files]);

  const rows = useMemo(
    () => (view === "tree" ? buildGitFileTreeRows(files, collapsedDirs) : []),
    [collapsedDirs, files, view],
  );

  const renderFile = (file: GitChangedFileDto, depth = 0) => (
    <FileRow
      key={`${zone}-${file.path}`}
      file={file}
      zone={zone}
      depth={depth}
      active={workingSelected && selectionPath === file.path}
      selected={selectedPaths.has(file.path)}
      dragging={Boolean(dragPaths?.includes(file.path))}
      busy={busy}
      stageLabel={stageLabel}
      onSelect={(e) => onFileSelect(file, e)}
      onToggleStage={() => onToggleStage(file)}
      onDragStart={(e) => onDragStart(file, e)}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => onContextMenu(file, e)}
    />
  );

  if (view === "tree") {
    return (
      <>
        {rows.map((row) =>
          row.kind === "dir" ? (
            <DirRow
              key={row.key}
              path={row.path}
              name={row.name}
              count={dirCounts.get(row.path) ?? 0}
              depth={row.depth}
              collapsed={collapsedDirs.has(row.path)}
              onToggle={() => onToggleDir(row.path)}
              onContextMenu={(e) => onDirContextMenu(row.path, e)}
            />
          ) : (
            renderFile(files[row.index]!, row.depth)
          ),
        )}
      </>
    );
  }

  return <>{files.map((file) => renderFile(file))}</>;
}

export function GitChangesCommitPane({
  files,
  conflictFiles,
  stagedFiles,
  unstagedFiles,
  view,
  stagedCount,
  busy,
  workingSelected,
  selectionPath,
  commitSummary,
  commitDescription,
  onSummaryChange,
  onDescriptionChange,
  onStageAll,
  onUnstageAll,
  onStagePaths,
  onSelectFile,
  onCommit,
  onCommitAndPush,
  onStageAndCommit,
  repoRoot,
  onDiscardPaths,
  onDeletePaths,
  onBlameFile,
  outgoing = [],
  outgoingLoading = false,
  commitHash = null,
  commitFilePath = null,
  outgoingFiles = [],
  onInspectOutgoing,
  onSelectOutgoingFile,
  onIgnorePaths,
}: {
  files: GitChangedFileDto[];
  conflictFiles: GitChangedFileDto[];
  stagedFiles: GitChangedFileDto[];
  unstagedFiles: GitChangedFileDto[];
  /** Row layout, switched from the navigator header. */
  view: ChangesView;
  stagedCount: number;
  busy: boolean;
  workingSelected: boolean;
  selectionPath: string | null;
  commitSummary: string;
  commitDescription: string;
  onSummaryChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onStagePaths: (paths: string[], staged: boolean) => void;
  onSelectFile: (path: string) => void;
  onCommit: (e: FormEvent) => void;
  onCommitAndPush: () => void;
  onStageAndCommit: () => void;
  repoRoot?: string;
  onDiscardPaths: (paths: string[]) => void | Promise<void>;
  onDeletePaths: (paths: string[]) => void | Promise<void>;
  onBlameFile: (path: string) => void | Promise<void>;
  outgoing?: GitCommitDto[];
  outgoingLoading?: boolean;
  commitHash?: string | null;
  commitFilePath?: string | null;
  outgoingFiles?: GitCommitFileDto[];
  onInspectOutgoing?: (hash: string) => void;
  onSelectOutgoingFile?: (hash: string, path: string) => void;
  /** Append the given repo-relative files or folders to the root .gitignore. */
  onIgnorePaths: (paths: string[]) => void | Promise<void>;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  const fileMenuStyle = useFixedMenuPlacement(fileMenu, menuRef);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [conflictsOpen, setConflictsOpen] = useState(true);
  const [outgoingOpen, setOutgoingOpen] = useState(true);
  const [expandedOutgoing, setExpandedOutgoing] = useState<string | null>(null);
  const [commitHeight, setCommitHeight] = useState(readCommitHeight);
  const [resizing, setResizing] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const [dropZone, setDropZone] = useState<StageZone | null>(null);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const lastClickRef = useRef<{ path: string; zone: StageZone } | null>(null);

  const sortedUnstaged = useMemo(() => sortGitFiles(unstagedFiles), [unstagedFiles]);
  const sortedStaged = useMemo(() => sortGitFiles(stagedFiles), [stagedFiles]);
  const sortedConflicts = useMemo(() => sortGitFiles(conflictFiles), [conflictFiles]);
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const closeFileMenu = useCallback(() => setFileMenu(null), []);

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const openFileMenu = useCallback((file: GitChangedFileDto, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileMenu({ kind: "file", x: e.clientX, y: e.clientY, file });
  }, []);

  const openDirMenu = useCallback((dirPath: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFileMenu({ kind: "dir", x: e.clientX, y: e.clientY, path: dirPath });
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

  const runMenuAction = useCallback(
    (action: () => void | Promise<void>) => {
      closeFileMenu();
      void action();
    },
    [closeFileMenu],
  );

  /** File behind the open context menu; null when it targets a folder. */
  const menuFile = fileMenu?.kind === "file" ? fileMenu.file : null;

  const copyMenuPaths = useCallback(
    async (paths: string[], absolute: boolean) => {
      const text = paths
        .map((rel) => (absolute && repoRoot ? toRepoAbsolutePath(repoRoot, rel) : normalizeGitPath(rel)))
        .join("\n");
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("common.copied"));
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
      }
    },
    [repoRoot, t],
  );

  const handleCopyRelativePath = useCallback(() => {
    if (!menuFile) return;
    return copyMenuPaths(resolveMenuPaths(menuFile, selectedPaths), false);
  }, [copyMenuPaths, menuFile, selectedPaths]);

  const handleCopyPath = useCallback(() => {
    if (!menuFile) return;
    return copyMenuPaths(resolveMenuPaths(menuFile, selectedPaths), true);
  }, [copyMenuPaths, menuFile, selectedPaths]);

  const handleCopyDirPath = useCallback(
    (dirPath: string, absolute: boolean) => copyMenuPaths([dirPath], absolute),
    [copyMenuPaths],
  );

  const handleOpenFile = useCallback(async () => {
    if (!menuFile || !repoRoot || isDeleted(menuFile)) return;
    const target = toRepoAbsolutePath(repoRoot, menuFile.path);
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.openFileFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [menuFile, repoRoot, t]);

  const handleShowInFolder = useCallback(async () => {
    if (!menuFile || !repoRoot) return;
    const target = revealPath(repoRoot, menuFile.path, isDeleted(menuFile));
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.showInFolderFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [menuFile, repoRoot, t]);

  const menuPaths = menuFile ? resolveMenuPaths(menuFile, selectedPaths) : [];
  const menuStagePaths = menuPaths.filter((path) => fileByPath.get(path)?.unstaged);
  const menuUnstagePaths = menuPaths.filter((path) => fileByPath.get(path)?.staged);
  const menuCanDiscard = menuPaths.some((path) => {
    const file = fileByPath.get(path);
    return file && (file.staged || file.unstaged);
  });
  const menuCanBlame = menuFile ? canBlame(menuFile) : false;
  const menuCanReveal = Boolean(repoRoot);
  const menuCanOpenFile = Boolean(repoRoot && menuFile && !isDeleted(menuFile));
  const menuConflictPaths = menuPaths.filter((path) => {
    const file = fileByPath.get(path);
    return file && isGitConflictFile(file);
  });
  const menuIgnorePaths = fileMenu?.kind === "file" ? resolveMenuPaths(fileMenu.file, selectedPaths) : [];

  const handleDelete = useCallback(async () => {
    const label =
      menuPaths.length > 1
        ? t("git.deleteFileConfirmMany", { count: menuPaths.length })
        : t("git.deleteFileConfirm", { path: normalizeGitPath(menuFile?.path ?? "") });
    if (!window.confirm(label)) return;
    await onDeletePaths(menuPaths);
  }, [menuFile, menuPaths, onDeletePaths, t]);

  const handleDiscard = useCallback(async () => {
    const label =
      menuPaths.length > 1
        ? t("git.discardChangesConfirmMany", { count: menuPaths.length })
        : t("git.discardChangesConfirm", { path: normalizeGitPath(menuFile?.path ?? "") });
    if (!window.confirm(label)) return;
    await onDiscardPaths(menuPaths);
  }, [menuFile, menuPaths, onDiscardPaths, t]);

  const handleDiscardDir = useCallback(
    async (dirPath: string) => {
      if (!window.confirm(t("git.discardFolderConfirm", { path: normalizeGitPath(dirPath) }))) return;
      await onDiscardPaths([dirPath]);
    },
    [onDiscardPaths, t],
  );

  const handleDeleteDir = useCallback(
    async (dirPath: string) => {
      if (!window.confirm(t("git.deleteFolderConfirm", { path: normalizeGitPath(dirPath) }))) return;
      await onDeletePaths([dirPath]);
    },
    [onDeletePaths, t],
  );

  const filePathsKey = files.map((f) => f.path).join("\0");
  const outgoingKey = outgoing.map((c) => c.hash).join("\0");

  useEffect(() => {
    setSelectedPaths((prev) => {
      const valid = new Set(files.map((f) => f.path));
      const next = new Set<string>();
      for (const path of prev) {
        if (valid.has(path)) next.add(path);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [filePathsKey, files]);

  useEffect(() => {
    if (expandedOutgoing && !outgoing.some((c) => c.hash === expandedOutgoing)) {
      setExpandedOutgoing(null);
    }
  }, [expandedOutgoing, outgoing, outgoingKey]);

  useEffect(() => {
    try {
      localStorage.setItem(COMMIT_HEIGHT_KEY, String(commitHeight));
    } catch {
      /* ignore */
    }
  }, [commitHeight]);

  const pathsInZone = useCallback(
    (zone: StageZone, onlySelected = false) => {
      const pool = zone === "staged" ? stagedFiles : unstagedFiles;
      if (!onlySelected) return pool.map((f) => f.path);
      return pool.filter((f) => selectedPaths.has(f.path)).map((f) => f.path);
    },
    [selectedPaths, stagedFiles, unstagedFiles],
  );

  const handleFileSelect = useCallback(
    (file: GitChangedFileDto, zone: StageZone, zoneVisible: GitChangedFileDto[], e: MouseEvent) => {
      const multiSelect = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!multiSelect && selectionPath === file.path) {
        onSelectFile(file.path);
        lastClickRef.current = { path: file.path, zone };
        return;
      }

      onSelectFile(file.path);
      setSelectedPaths((prev) => {
        if (e.shiftKey && lastClickRef.current?.zone === zone) {
          const paths = zoneVisible.map((f) => f.path);
          const anchor = lastClickRef.current.path;
          const a = paths.indexOf(anchor);
          const b = paths.indexOf(file.path);
          if (a >= 0 && b >= 0) {
            const [start, end] = a < b ? [a, b] : [b, a];
            const next = e.ctrlKey || e.metaKey ? new Set(prev) : new Set<string>();
            for (let i = start; i <= end; i++) next.add(paths[i]!);
            return next;
          }
        }
        if (e.ctrlKey || e.metaKey) {
          const next = new Set(prev);
          if (next.has(file.path)) next.delete(file.path);
          else next.add(file.path);
          return next;
        }
        return new Set([file.path]);
      });
      lastClickRef.current = { path: file.path, zone };
    },
    [onSelectFile, selectionPath, workingSelected],
  );

  const resolveDragPaths = useCallback(
    (file: GitChangedFileDto, zone: StageZone) => {
      if (selectedPaths.has(file.path)) {
        const inZone = pathsInZone(zone, true);
        if (inZone.length > 0) return inZone;
      }
      return [file.path];
    },
    [pathsInZone, selectedPaths],
  );

  const handleDragStart = useCallback(
    (file: GitChangedFileDto, zone: StageZone, e: DragEvent) => {
      const paths = resolveDragPaths(file, zone);
      e.dataTransfer.setData(DND_MIME, JSON.stringify(paths));
      e.dataTransfer.effectAllowed = "move";
      setDragPaths(paths);
    },
    [resolveDragPaths],
  );

  const handleDragEnd = useCallback(() => {
    setDragPaths(null);
    setDropZone(null);
  }, []);

  const handleDrop = useCallback(
    (zone: StageZone, e: DragEvent) => {
      e.preventDefault();
      setDropZone(null);
      setDragPaths(null);
      const paths = parseDragPaths(e);
      if (paths.length === 0) return;
      const toStage = zone === "staged";
      const applicable = paths.filter((path) => {
        const file = files.find((f) => f.path === path);
        if (!file) return false;
        return toStage ? file.unstaged : file.staged;
      });
      if (applicable.length > 0) onStagePaths(applicable, toStage);
    },
    [files, onStagePaths],
  );

  const toggleStageForFile = useCallback(
    (file: GitChangedFileDto, zone: StageZone) => {
      const selectedInZone = pathsInZone(zone, true);
      const paths =
        selectedInZone.length > 1 && selectedPaths.has(file.path) ? selectedInZone : [file.path];
      onStagePaths(paths, zone === "unstaged");
    },
    [onStagePaths, pathsInZone, selectedPaths],
  );

  const onResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeDragRef.current = { startY: e.clientY, startHeight: commitHeight };
      setResizing(true);
    },
    [commitHeight],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const next = drag.startHeight - (e.clientY - drag.startY);
      setCommitHeight(Math.min(COMMIT_HEIGHT_MAX, Math.max(COMMIT_HEIGHT_MIN, next)));
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

  const selectedUnstaged = pathsInZone("unstaged", true).length;
  const selectedStaged = pathsInZone("staged", true).length;
  const canCommit = stagedCount > 0 && commitSummary.trim().length > 0;
  const primaryLabel =
    stagedCount > 0 ? t("git.commitStaged", { count: stagedCount }) : t("git.stageToCommit");

  const toggleOutgoingCommit = useCallback(
    (hash: string) => {
      if (expandedOutgoing === hash) {
        setExpandedOutgoing(null);
        return;
      }
      setExpandedOutgoing(hash);
      onInspectOutgoing?.(hash);
    },
    [expandedOutgoing, onInspectOutgoing],
  );

  const outgoingSection =
    outgoing.length > 0 ? (
      <ChangesSection
        title={t("git.outgoingCommits")}
        count={outgoing.length}
        collapsed={!outgoingOpen}
        onToggle={() => setOutgoingOpen((v) => !v)}
        stageZone="unstaged"
        dropActive={false}
        enableDrop={false}
        onDragOverZone={() => undefined}
        onDragLeaveZone={() => undefined}
        onDropZone={() => undefined}
      >
        {outgoing.map((commit) => {
          const open = expandedOutgoing === commit.hash;
          const filesForCommit = open && commitHash === commit.hash ? outgoingFiles : [];
          return (
            <div key={commit.hash} className={styles.outgoingCommit}>
              <button
                type="button"
                className={`${styles.outgoingRow}${commitHash === commit.hash ? ` ${styles.outgoingRowActive}` : ""}`}
                onClick={() => toggleOutgoingCommit(commit.hash)}
                title={commit.subject}
              >
                <svg
                  className={`${styles.sectionChevron}${open ? "" : ` ${styles.sectionChevronCollapsed}`}`}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M8 10l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className={styles.outgoingSubject}>{commit.subject || commit.shortHash}</span>
                <span className={styles.outgoingHash}>{commit.shortHash}</span>
              </button>
              {open ? (
                <div className={styles.outgoingFiles}>
                  {outgoingLoading && filesForCommit.length === 0 ? (
                    <p className={styles.sectionEmpty}>{t("common.loading")}</p>
                  ) : filesForCommit.length === 0 ? (
                    <p className={styles.sectionEmpty}>{t("git.pickFileForDiff")}</p>
                  ) : (
                    filesForCommit.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`${styles.outgoingFile}${
                          commitHash === commit.hash && commitFilePath === file.path
                            ? ` ${styles.outgoingFileActive}`
                            : ""
                        }`}
                        onClick={() => onSelectOutgoingFile?.(commit.hash, file.path)}
                        title={file.path}
                      >
                        <span className={styles.outgoingFileName}>
                          {file.path.split("/").pop() || file.path}
                        </span>
                        <GitDiffStats additions={file.additions} deletions={file.deletions} />
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </ChangesSection>
    ) : null;

  /** Row rendering shared by the conflict/unstaged/staged sections. */
  const fileListProps = {
    view,
    collapsedDirs,
    workingSelected,
    selectionPath,
    selectedPaths,
    dragPaths,
    busy,
    onToggleDir: toggleDir,
    onDragEnd: handleDragEnd,
    onContextMenu: openFileMenu,
    onDirContextMenu: openDirMenu,
  };

  const treePane = (
    <div className={styles.filesArea}>
      {outgoingSection}
      {files.length === 0 ? (
        outgoing.length === 0 ? <div className={styles.empty}>{t("git.noChanges")}</div> : null
      ) : (
        <>
          {conflictFiles.length > 0 ? (
            <ChangesSection
              title={t("git.conflictFiles")}
              count={conflictFiles.length}
              collapsed={!conflictsOpen}
              onToggle={() => setConflictsOpen((v) => !v)}
              stageZone="unstaged"
              dropActive={false}
              onDragOverZone={() => undefined}
              onDragLeaveZone={() => undefined}
              onDropZone={() => undefined}
            >
              <FileList
                {...fileListProps}
                files={sortedConflicts}
                zone="unstaged"
                stageLabel={t("git.stageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "unstaged", sortedConflicts, e)}
                onToggleStage={(file) => toggleStageForFile(file, "unstaged")}
                onDragStart={(file, e) => handleDragStart(file, "unstaged", e)}
              />
            </ChangesSection>
          ) : null}

          <ChangesSection
            title={t("git.unstagedFiles")}
            count={unstagedFiles.length}
            collapsed={!unstagedOpen}
            onToggle={() => setUnstagedOpen((v) => !v)}
            stageZone="unstaged"
            dropActive={dropZone === "unstaged"}
            onDragOverZone={setDropZone}
            onDragLeaveZone={(zone) => setDropZone((cur) => (cur === zone ? null : cur))}
            onDropZone={handleDrop}
            action={
              unstagedFiles.length > 0 ? (
                <button
                  type="button"
                  className={styles.sectionAction}
                  disabled={busy}
                  onClick={() =>
                    selectedUnstaged > 1
                      ? onStagePaths(pathsInZone("unstaged", true), true)
                      : onStageAll()
                  }
                >
                  {selectedUnstaged > 1
                    ? t("git.stageSelected", { count: selectedUnstaged })
                    : t("git.stageAll")}
                </button>
              ) : null
            }
          >
            {unstagedFiles.length === 0 ? (
              <p className={styles.sectionEmpty}>{t("git.noUnstaged")}</p>
            ) : (
              <FileList
                {...fileListProps}
                files={sortedUnstaged}
                zone="unstaged"
                stageLabel={t("git.stageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "unstaged", sortedUnstaged, e)}
                onToggleStage={(file) => toggleStageForFile(file, "unstaged")}
                onDragStart={(file, e) => handleDragStart(file, "unstaged", e)}
              />
            )}
          </ChangesSection>

          <ChangesSection
            title={t("git.stagedFiles")}
            count={stagedFiles.length}
            collapsed={!stagedOpen}
            onToggle={() => setStagedOpen((v) => !v)}
            stageZone="staged"
            dropActive={dropZone === "staged"}
            onDragOverZone={setDropZone}
            onDragLeaveZone={(zone) => setDropZone((cur) => (cur === zone ? null : cur))}
            onDropZone={handleDrop}
            action={
              stagedFiles.length > 0 ? (
                <button
                  type="button"
                  className={styles.sectionAction}
                  disabled={busy}
                  onClick={() =>
                    selectedStaged > 1
                      ? onStagePaths(pathsInZone("staged", true), false)
                      : onUnstageAll()
                  }
                >
                  {selectedStaged > 1
                    ? t("git.unstageSelected", { count: selectedStaged })
                    : t("git.unstageAll")}
                </button>
              ) : null
            }
          >
            {stagedFiles.length === 0 ? (
              <p className={styles.sectionEmpty}>{t("git.noStaged")}</p>
            ) : (
              <FileList
                {...fileListProps}
                files={sortedStaged}
                zone="staged"
                stageLabel={t("git.unstageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "staged", sortedStaged, e)}
                onToggleStage={(file) => toggleStageForFile(file, "staged")}
                onDragStart={(file, e) => handleDragStart(file, "staged", e)}
              />
            )}
          </ChangesSection>
        </>
      )}
    </div>
  );

  /**
   * The commit box is a fixed-height dock under the file list; the drag handle
   * above it is the only thing that decides how much of the list is left.
   */
  const commitPane = (
    <>
      <div
        className={styles.commitResize}
        onPointerDown={onResizeDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("git.resizeCommit")}
        title={t("git.resizeCommit")}
      />
      <form
        className={styles.commitSection}
        style={{ height: `${commitHeight}px` }}
        onSubmit={(e) => {
          if (stagedCount > 0) void onCommit(e);
          else {
            e.preventDefault();
            onStageAndCommit();
          }
        }}
      >
        <div className={styles.commitHead}>
          <span className={styles.commitHeadTitle}>{t("git.commitMessage")}</span>
          {selectedPaths.size > 1 ? (
            <span className={styles.selectionHint}>{t("git.selectedCount", { count: selectedPaths.size })}</span>
          ) : null}
        </div>
        <div className={styles.commitFields}>
          <input
            type="text"
            className={styles.summaryInput}
            value={commitSummary}
            onChange={(e) => onSummaryChange(e.target.value)}
            placeholder={t("git.commitSummary")}
            disabled={busy}
          />
          <textarea
            className={styles.descriptionInput}
            value={commitDescription}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder={t("git.commitDescription")}
            disabled={busy}
          />
        </div>
        <div className={styles.commitActions}>
          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={busy || (stagedCount > 0 && !canCommit)}
          >
            {primaryLabel}
          </button>
          {stagedCount > 0 ? (
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={busy || !canCommit}
              onClick={() => onCommitAndPush()}
            >
              {t("git.commitAndPush")}
            </button>
          ) : null}
        </div>
      </form>
    </>
  );

  return (
    <div className={`${styles.pane}${resizing ? ` ${styles.paneResizing}` : ""}`}>
      {treePane}
      {commitPane}
      {fileMenu ? (
        <div
          ref={menuRef}
          className={styles.contextMenu}
          style={fileMenuStyle ?? undefined}
          role="menu"
          aria-label={t("git.fileMenu")}
        >
          {fileMenu.kind === "file" ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => runMenuAction(() => onSelectFile(fileMenu.file.path))}
              >
                {t("git.viewDiff")}
              </button>
              {menuConflictPaths.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => runMenuAction(() => onStagePaths(menuConflictPaths, true))}
                >
                  {menuConflictPaths.length > 1
                    ? t("git.markConflictsResolvedMany", { count: menuConflictPaths.length })
                    : t("git.markConflictResolved")}
                </button>
              ) : null}
              {menuStagePaths.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => runMenuAction(() => onStagePaths(menuStagePaths, true))}
                >
                  {menuStagePaths.length > 1
                    ? t("git.stageSelected", { count: menuStagePaths.length })
                    : t("git.stage")}
                </button>
              ) : null}
              {menuUnstagePaths.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => runMenuAction(() => onStagePaths(menuUnstagePaths, false))}
                >
                  {menuUnstagePaths.length > 1
                    ? t("git.unstageSelected", { count: menuUnstagePaths.length })
                    : t("git.unstage")}
                </button>
              ) : null}
              {menuCanDiscard ? (
                <button type="button" role="menuitem" disabled={busy} onClick={() => runMenuAction(handleDiscard)}>
                  {t("git.discardChanges")}
                </button>
              ) : null}
              {menuConflictPaths.length > 0 ||
              menuStagePaths.length > 0 ||
              menuUnstagePaths.length > 0 ||
              menuCanDiscard ? (
                <div className={styles.contextMenuDivider} aria-hidden />
              ) : null}
              <button type="button" role="menuitem" onClick={() => runMenuAction(handleCopyRelativePath)}>
                {t("git.copyRelativePath")}
              </button>
              <button type="button" role="menuitem" onClick={() => runMenuAction(handleCopyPath)}>
                {t("git.copyFilePath")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!menuCanOpenFile}
                onClick={() => runMenuAction(handleOpenFile)}
              >
                {t("git.openFile")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!menuCanReveal}
                onClick={() => runMenuAction(handleShowInFolder)}
              >
                {t("git.showInFolder")}
              </button>
              {menuCanBlame ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => runMenuAction(() => onBlameFile(fileMenu.file.path))}
                >
                  {t("git.fileBlame")}
                </button>
              ) : null}
              <div className={styles.contextMenuDivider} aria-hidden />
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => runMenuAction(() => onIgnorePaths(menuIgnorePaths))}
              >
                {t("git.addToGitIgnore")}
              </button>
              <div className={styles.contextMenuDivider} aria-hidden />
              <button
                type="button"
                role="menuitem"
                className={styles.contextMenuDanger}
                disabled={busy}
                onClick={() => runMenuAction(handleDelete)}
              >
                {t("git.deleteFile")}
              </button>
              {menuCanDiscard ? (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.contextMenuDanger}
                  disabled={busy}
                  onClick={() => runMenuAction(handleDiscard)}
                >
                  {t("git.discardChanges")}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => runMenuAction(() => onIgnorePaths([fileMenu.path]))}
              >
                {t("git.addToGitIgnore")}
              </button>
              <div className={styles.contextMenuDivider} aria-hidden />
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenuAction(() => handleCopyDirPath(fileMenu.path, false))}
              >
                {t("git.copyRelativePath")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!repoRoot}
                onClick={() => runMenuAction(() => handleCopyDirPath(fileMenu.path, true))}
              >
                {t("git.copyFilePath")}
              </button>
              <div className={styles.contextMenuDivider} aria-hidden />
              <button
                type="button"
                role="menuitem"
                className={styles.contextMenuDanger}
                disabled={busy}
                onClick={() => runMenuAction(() => handleDiscardDir(fileMenu.path))}
              >
                {t("git.discardFolder")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.contextMenuDanger}
                disabled={busy}
                onClick={() => runMenuAction(() => handleDeleteDir(fileMenu.path))}
              >
                {t("git.deleteFolder")}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
