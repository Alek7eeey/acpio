import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { GitChangedFileDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { joinRepoPath, normalizeGitPath, sortGitFiles, toRepoAbsolutePath } from "../lib/gitFileTree";
import { gitStatusBadge, isGitConflictFile } from "../lib/gitUi";
import { GitDiffStats } from "./GitDiffStats";
import { showToast } from "../lib/toast";
import styles from "./GitChangesCommitPane.module.css";

const COMMIT_HEIGHT_KEY = "acpio.gitCommitSectionHeight.v1";
const COMMIT_HEIGHT_DEFAULT = 168;
const COMMIT_HEIGHT_MIN = 120;
const COMMIT_HEIGHT_MAX = 360;
const DND_MIME = "application/x-acpio-git-paths";

type StageZone = "staged" | "unstaged";
type PaneLayout = "stacked" | "workspace";
type FileMenuState = { x: number; y: number; file: GitChangedFileDto; zone: StageZone };

function isUntracked(file: GitChangedFileDto) {
  return file.index === "?" || file.worktree === "?";
}

function isDeleted(file: GitChangedFileDto) {
  return file.index === "D" || file.worktree === "D";
}

function canBlame(file: GitChangedFileDto) {
  return !isUntracked(file);
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
          className={`${styles.sectionBody}${dropActive ? ` ${styles.sectionBodyDrop}` : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            onDragOverZone(stageZone);
          }}
          onDragLeave={() => onDragLeaveZone(stageZone)}
          onDrop={(e) => onDropZone(stageZone, e)}
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

function FileList({
  files,
  zone,
  workingSelected,
  selectionPath,
  selectedPaths,
  dragPaths,
  busy,
  stageLabel,
  onFileSelect,
  onToggleStage,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: {
  files: GitChangedFileDto[];
  zone: StageZone;
  workingSelected: boolean;
  selectionPath: string | null;
  selectedPaths: Set<string>;
  dragPaths: string[] | null;
  busy: boolean;
  stageLabel: string;
  onFileSelect: (file: GitChangedFileDto, e: MouseEvent) => void;
  onToggleStage: (file: GitChangedFileDto) => void;
  onDragStart: (file: GitChangedFileDto, e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (file: GitChangedFileDto, zone: StageZone, e: MouseEvent) => void;
}) {
  return (
    <>
      {files.map((file) => (
        <FileRow
          key={`${zone}-${file.path}`}
          file={file}
          zone={zone}
          active={workingSelected && selectionPath === file.path}
          selected={selectedPaths.has(file.path)}
          dragging={Boolean(dragPaths?.includes(file.path))}
          busy={busy}
          stageLabel={stageLabel}
          onSelect={(e) => onFileSelect(file, e)}
          onToggleStage={() => onToggleStage(file)}
          onDragStart={(e) => onDragStart(file, e)}
          onDragEnd={onDragEnd}
          onContextMenu={(e) => onContextMenu(file, zone, e)}
        />
      ))}
    </>
  );
}

export function GitChangesCommitPane({
  files,
  conflictFiles,
  stagedFiles,
  unstagedFiles,
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
  onStageAndCommit,
  repoRoot,
  onDiscardPaths,
  onDeletePaths,
  onBlameFile,
  layout = "stacked",
}: {
  files: GitChangedFileDto[];
  conflictFiles: GitChangedFileDto[];
  stagedFiles: GitChangedFileDto[];
  unstagedFiles: GitChangedFileDto[];
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
  onStageAndCommit: () => void;
  repoRoot?: string;
  onDiscardPaths: (paths: string[]) => void | Promise<void>;
  onDeletePaths: (paths: string[]) => void | Promise<void>;
  onBlameFile: (path: string) => void | Promise<void>;
  layout?: PaneLayout;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [conflictsOpen, setConflictsOpen] = useState(true);
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

  const openFileMenu = useCallback(
    (file: GitChangedFileDto, zone: StageZone, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setFileMenu({ x: e.clientX, y: e.clientY, file, zone });
    },
    [],
  );

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

  const handleCopyRelativePath = useCallback(async () => {
    if (!fileMenu) return;
    const paths = resolveMenuPaths(fileMenu.file, selectedPaths);
    const text = paths.map((rel) => normalizeGitPath(rel)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [fileMenu, selectedPaths, t]);

  const handleCopyPath = useCallback(async () => {
    if (!fileMenu) return;
    const paths = resolveMenuPaths(fileMenu.file, selectedPaths);
    const text = paths
      .map((rel) => (repoRoot ? toRepoAbsolutePath(repoRoot, rel) : normalizeGitPath(rel)))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("common.copied"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [fileMenu, repoRoot, selectedPaths, t]);

  const handleOpenFile = useCallback(async () => {
    if (!fileMenu || !repoRoot || isDeleted(fileMenu.file)) return;
    const target = toRepoAbsolutePath(repoRoot, fileMenu.file.path);
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.openFileFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [fileMenu, repoRoot, t]);

  const handleShowInFolder = useCallback(async () => {
    if (!fileMenu || !repoRoot) return;
    const target = revealPath(repoRoot, fileMenu.file.path, isDeleted(fileMenu.file));
    try {
      const result = await api.openPath(target);
      if (!result.ok) showToast(t("git.showInFolderFailed"));
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e));
    }
  }, [fileMenu, repoRoot, t]);

  const menuPaths = fileMenu ? resolveMenuPaths(fileMenu.file, selectedPaths) : [];
  const menuStagePaths = menuPaths.filter((path) => fileByPath.get(path)?.unstaged);
  const menuUnstagePaths = menuPaths.filter((path) => fileByPath.get(path)?.staged);
  const menuCanDiscard = menuPaths.some((path) => {
    const file = fileByPath.get(path);
    return file && (file.staged || file.unstaged);
  });
  const menuCanBlame = fileMenu ? canBlame(fileMenu.file) : false;
  const menuCanReveal = Boolean(repoRoot);
  const menuCanOpenFile = Boolean(repoRoot && fileMenu && !isDeleted(fileMenu.file));
  const menuConflictPaths = menuPaths.filter((path) => {
    const file = fileByPath.get(path);
    return file && isGitConflictFile(file);
  });

  const filePathsKey = files.map((f) => f.path).join("\0");

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

  const treePane = (
    <div className={styles.filesArea}>
      {files.length === 0 ? (
        <div className={styles.empty}>{t("git.noChanges")}</div>
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
                files={sortedConflicts}
                zone="unstaged"
                workingSelected={workingSelected}
                selectionPath={selectionPath}
                selectedPaths={selectedPaths}
                dragPaths={dragPaths}
                busy={busy}
                stageLabel={t("git.stageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "unstaged", sortedConflicts, e)}
                onToggleStage={(file) => toggleStageForFile(file, "unstaged")}
                onDragStart={(file, e) => handleDragStart(file, "unstaged", e)}
                onDragEnd={handleDragEnd}
                onContextMenu={openFileMenu}
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
                files={sortedUnstaged}
                zone="unstaged"
                workingSelected={workingSelected}
                selectionPath={selectionPath}
                selectedPaths={selectedPaths}
                dragPaths={dragPaths}
                busy={busy}
                stageLabel={t("git.stageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "unstaged", sortedUnstaged, e)}
                onToggleStage={(file) => toggleStageForFile(file, "unstaged")}
                onDragStart={(file, e) => handleDragStart(file, "unstaged", e)}
                onDragEnd={handleDragEnd}
                onContextMenu={openFileMenu}
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
                files={sortedStaged}
                zone="staged"
                workingSelected={workingSelected}
                selectionPath={selectionPath}
                selectedPaths={selectedPaths}
                dragPaths={dragPaths}
                busy={busy}
                stageLabel={t("git.unstageFile")}
                onFileSelect={(file, e) => handleFileSelect(file, "staged", sortedStaged, e)}
                onToggleStage={(file) => toggleStageForFile(file, "staged")}
                onDragStart={(file, e) => handleDragStart(file, "staged", e)}
                onDragEnd={handleDragEnd}
                onContextMenu={openFileMenu}
              />
            )}
          </ChangesSection>
        </>
      )}
    </div>
  );

  const commitPane = (
    <div className={layout === "workspace" ? styles.commitDock : styles.commitStack}>
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
        <button
          type="submit"
          className={styles.primaryBtn}
          disabled={busy || (stagedCount > 0 && !canCommit)}
        >
          {primaryLabel}
        </button>
      </form>
    </div>
  );

  return (
    <div
      className={`${styles.pane}${resizing ? ` ${styles.paneResizing}` : ""}${
        layout === "workspace" ? ` ${styles.paneWorkspace}` : ""
      }`}
    >
      {treePane}
      {commitPane}
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
              {menuStagePaths.length > 1 ? t("git.stageSelected", { count: menuStagePaths.length }) : t("git.stage")}
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
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() =>
                runMenuAction(async () => {
                  const label =
                    menuPaths.length > 1
                      ? t("git.discardChangesConfirmMany", { count: menuPaths.length })
                      : t("git.discardChangesConfirm", { path: normalizeGitPath(fileMenu.file.path) });
                  if (!window.confirm(label)) return;
                  await onDiscardPaths(menuPaths);
                })
              }
            >
              {t("git.discardChanges")}
            </button>
          ) : null}
          {(menuConflictPaths.length > 0 || menuStagePaths.length > 0 || menuUnstagePaths.length > 0 || menuCanDiscard) ? (
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
            className={styles.contextMenuDanger}
            disabled={busy}
            onClick={() =>
              runMenuAction(async () => {
                const label =
                  menuPaths.length > 1
                    ? t("git.deleteFileConfirmMany", { count: menuPaths.length })
                    : t("git.deleteFileConfirm", { path: normalizeGitPath(fileMenu.file.path) });
                if (!window.confirm(label)) return;
                await onDeletePaths(menuPaths);
              })
            }
          >
            {t("git.deleteFile")}
          </button>
          {menuCanDiscard ? (
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuDanger}
              disabled={busy}
              onClick={() =>
                runMenuAction(async () => {
                  const label =
                    menuPaths.length > 1
                      ? t("git.discardChangesConfirmMany", { count: menuPaths.length })
                      : t("git.discardChangesConfirm", { path: normalizeGitPath(fileMenu.file.path) });
                  if (!window.confirm(label)) return;
                  await onDiscardPaths(menuPaths);
                })
              }
            >
              {t("git.discardChanges")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
