import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import styles from "./ServerFolderBrowseDialog.module.css";

type ServerFolderBrowseDialogProps = {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

type BrowseState = {
  path: string;
  parent: string | null;
  kind?: "drives" | "directory";
  entries: Array<{ name: string; path: string }>;
};

const DRIVES_ROOT = "Computer";

const folderIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      fill="currentColor"
      opacity="0.18"
    />
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const driveIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8" cy="12" r="1.2" fill="currentColor" />
    <path d="M12 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const upIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 19V5M12 5l-6 6M12 5l6 6"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function isWindowsPath(path: string) {
  return path === DRIVES_ROOT || /^[a-zA-Z]:/.test(path) || path.includes("\\");
}

function folderLeafName(pathValue: string, drivesLabel: string) {
  if (pathValue === DRIVES_ROOT) return drivesLabel;
  const trimmed = pathValue.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return pathValue;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

function splitPathSegments(
  fullPath: string,
  drivesLabel: string,
): Array<{ label: string; path: string }> {
  if (fullPath === DRIVES_ROOT) {
    return [{ label: drivesLabel, path: DRIVES_ROOT }];
  }

  const trimmed = fullPath.trim();
  if (!trimmed) return [];

  // Filesystem root on Unix
  if (trimmed === "/" || trimmed === "\\") {
    return [{ label: "/", path: "/" }];
  }

  const winDrive = trimmed.match(/^([a-zA-Z]:)([\\/]|$)/);
  const isUnixAbsolute = trimmed.startsWith("/");
  const sep = trimmed.includes("\\") && !isUnixAbsolute ? "\\" : "/";
  const rawParts = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const parts: string[] = [];

  if (winDrive) {
    parts.push(winDrive[1]);
    parts.push(...rawParts.slice(1));
  } else {
    parts.push(...rawParts);
  }

  const segments: Array<{ label: string; path: string }> = [];
  if (winDrive) {
    segments.push({ label: drivesLabel, path: DRIVES_ROOT });
  } else if (isUnixAbsolute) {
    segments.push({ label: "/", path: "/" });
  }

  for (let i = 0; i < parts.length; i++) {
    if (winDrive && i === 0) {
      segments.push({ label: parts[i], path: `${parts[i]}\\` });
      continue;
    }
    const slice = winDrive ? [winDrive[1], ...parts.slice(1, i + 1)] : parts.slice(0, i + 1);
    const path = winDrive
      ? `${slice[0]}\\${slice.slice(1).join("\\")}`
      : isUnixAbsolute
        ? `/${slice.join("/")}`.replace(/\/+/g, "/")
        : slice.join(sep);
    segments.push({ label: parts[i], path });
  }
  return segments;
}

export function ServerFolderBrowseDialog({
  open,
  initialPath,
  onClose,
  onSelect,
}: ServerFolderBrowseDialogProps) {
  const t = useT();
  const drivesLabel = t("common.thisPc");
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const loadSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const loadBrowse = async (path?: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseDirectory(path);
      if (seq !== loadSeq.current) return;
      setBrowse(res);
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: 0 });
      });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      loadSeq.current += 1;
      setBrowse(null);
      setLoading(false);
      setError(null);
      return;
    }
    void loadBrowse(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && browse?.path && browse.path !== DRIVES_ROOT) {
        e.preventDefault();
        confirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, browse?.path]);

  const breadcrumbs = useMemo(
    () => (browse?.path ? splitPathSegments(browse.path, drivesLabel) : []),
    [browse?.path, drivesLabel],
  );
  const crumbSep =
    browse?.path && isWindowsPath(browse.path) && browse.path !== DRIVES_ROOT ? "\\" : "/";
  const isDrivesView = browse?.kind === "drives" || browse?.path === DRIVES_ROOT;
  const canConfirm = Boolean(browse?.path && browse.path !== DRIVES_ROOT);

  useEffect(() => {
    if (newFolderMode) newFolderRef.current?.focus();
  }, [newFolderMode]);

  const confirm = () => {
    if (!browse?.path || browse.path === DRIVES_ROOT) return;
    onSelect(browse.path);
    onClose();
  };

  const navigate = (path: string) => {
    void loadBrowse(path);
  };

  const createNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !browse?.path || browse.path === DRIVES_ROOT || newFolderBusy) return;
    const sep = browse.path.includes("\\") ? "\\" : "/";
    const fullPath = `${browse.path}${sep}${name}`;
    setNewFolderBusy(true);
    setError(null);
    try {
      await api.createFolder(fullPath);
      setNewFolderMode(false);
      setNewFolderName("");
      await loadBrowse(fullPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNewFolderBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className={styles.overlay}>
      <button type="button" className={styles.backdrop} aria-label={t("common.cancel")} onClick={onClose} />
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("common.selectFolder")}>
        <div className={styles.titleBar}>
          <div className={styles.titleLeft}>
            <span className={styles.titleIcon}>{folderIcon}</span>
            <h2 className={styles.title}>{t("common.selectFolder")}</h2>
          </div>
          <button type="button" className={styles.closeBtn} aria-label={t("common.cancel")} onClick={onClose}>
            ×
          </button>
        </div>

        <div className={styles.navBar}>
          <button
            type="button"
            className={styles.upBtn}
            disabled={!browse?.parent || loading}
            aria-label={t("common.parentFolder")}
            title={t("common.parentFolder")}
            onClick={() => browse?.parent && navigate(browse.parent)}
          >
            {upIcon}
          </button>
          <div className={styles.addressBar} aria-label={t("common.folderPath")}>
            {breadcrumbs.length === 0 ? (
              <span className={styles.crumbMuted}>{loading ? t("common.loading") : "…"}</span>
            ) : (
              breadcrumbs.map((crumb, index) => (
                <span key={crumb.path} className={styles.crumbWrap}>
                  {index > 0 ? <span className={styles.crumbSep}>{crumbSep}</span> : null}
                  <button
                    type="button"
                    className={`${styles.crumb}${index === breadcrumbs.length - 1 ? ` ${styles.crumbActive}` : ""}`}
                    onClick={() => navigate(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <div className={styles.listPane} ref={listRef} role="listbox" aria-label={t("common.browseFolders")}>
          {!browse && loading ? (
            <p className={styles.empty}>{t("common.loading")}</p>
          ) : browse ? (
            <>
              {browse.parent ? (
                <button
                  type="button"
                  role="option"
                  className={styles.row}
                  aria-label={t("common.parentFolder")}
                  onClick={() => navigate(browse.parent!)}
                >
                  <span className={styles.rowIcon}>{folderIcon}</span>
                  <span className={styles.rowName}>..</span>
                </button>
              ) : null}
              {browse.entries.length === 0 && !browse.parent ? (
                <p className={styles.empty}>{t("common.folder")}</p>
              ) : (
                browse.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    className={styles.row}
                    onClick={() => navigate(entry.path)}
                  >
                    <span className={styles.rowIcon}>{isDrivesView ? driveIcon : folderIcon}</span>
                    <span className={styles.rowName}>{entry.name}</span>
                  </button>
                ))
              )}
            </>
          ) : null}
        </div>

        <div className={styles.footer}>
          <label className={styles.folderField}>
            <span className={styles.folderLabel}>{t("common.folder")}</span>
            <input
              className={styles.folderInput}
              value={browse?.path ? folderLeafName(browse.path, drivesLabel) : ""}
              readOnly
              title={browse?.path && browse.path !== DRIVES_ROOT ? browse.path : ""}
            />
          </label>
          {newFolderMode && !isDrivesView ? (
            <div className={styles.newFolderRow}>
              <input
                ref={newFolderRef}
                className={styles.folderInput}
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={t("common.newFolderPlaceholder")}
                aria-label={t("common.newFolderPlaceholder")}
                disabled={newFolderBusy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createNewFolder();
                  if (e.key === "Escape") { setNewFolderMode(false); setNewFolderName(""); setError(null); }
                }}
              />
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={newFolderBusy || !newFolderName.trim()}
                onClick={() => void createNewFolder()}
              >
                {t("common.create")}
              </button>
            </div>
          ) : null}
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            {!isDrivesView ? (
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={loading || newFolderBusy}
                onClick={() => { setNewFolderMode(!newFolderMode); setNewFolderName(""); setError(null); }}
              >
                {newFolderMode ? t("common.cancel") : t("common.newFolder")}
              </button>
            ) : null}
            <button type="button" className={styles.secondaryBtn} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={loading || !canConfirm || newFolderBusy}
              onClick={confirm}
            >
              {t("common.selectFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
