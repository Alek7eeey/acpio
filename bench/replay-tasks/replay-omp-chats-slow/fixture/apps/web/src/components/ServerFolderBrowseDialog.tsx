import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { DRIVES_ROOT, isWindowsPath, splitPathSegments } from "../lib/pathSegments";
import styles from "./ServerFolderBrowseDialog.module.css";

type ServerFolderBrowseDialogProps = {
  open: boolean;
  initialPath?: string;
  /** "select" — confirm the browsed folder; "create" — primary button creates a new folder and selects it. */
  mode?: "select" | "create";
  onClose: () => void;
  onSelect: (path: string) => void;
};

type BrowseState = {
  path: string;
  parent: string | null;
  kind?: "drives" | "directory";
  entries: Array<{ name: string; path: string }>;
};

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

function folderLeafName(pathValue: string, drivesLabel: string) {
  if (pathValue === DRIVES_ROOT) return drivesLabel;
  const trimmed = pathValue.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return pathValue;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

export function ServerFolderBrowseDialog({
  open,
  initialPath,
  mode = "select",
  onClose,
  onSelect,
}: ServerFolderBrowseDialogProps) {
  const t = useT();
  const drivesLabel = t("common.thisPc");
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderBusy, setNewFolderBusy] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const loadSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const startPathEdit = () => {
    if (!browse?.path) return;
    setPathDraft(browse.path);
    setEditingPath(true);
    requestAnimationFrame(() => pathInputRef.current?.select());
  };

  const commitPathEdit = async () => {
    const target = pathDraft.trim();
    if (!target) {
      setEditingPath(false);
      return;
    }
    const mapped =
      target === DRIVES_ROOT || target === t("common.thisPc") ? DRIVES_ROOT : target;
    const res = await loadBrowse(mapped);
    if (res) setEditingPath(false);
  };

  const loadBrowse = async (path?: string): Promise<BrowseState | null> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseDirectory(path);
      if (seq !== loadSeq.current) return null;
      setBrowse(res);
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: 0 });
      });
      return res;
    } catch (err) {
      if (seq !== loadSeq.current) return null;
      setError(err instanceof Error ? err.message : String(err));
      return null;
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
      setNewFolderName("");
      return;
    }
    void loadBrowse(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target === pathInputRef.current) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && browse?.path && browse.path !== DRIVES_ROOT) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, browse?.path, newFolderName]);

  const breadcrumbs = useMemo(
    () => (browse?.path ? splitPathSegments(browse.path, drivesLabel) : []),
    [browse?.path, drivesLabel],
  );
  const crumbSep =
    browse?.path && isWindowsPath(browse.path) && browse.path !== DRIVES_ROOT ? "\\" : "/";
  const isDrivesView = browse?.kind === "drives" || browse?.path === DRIVES_ROOT;
  const canConfirm = Boolean(browse?.path && browse.path !== DRIVES_ROOT);

  useEffect(() => {
    if (open && mode === "create") newFolderRef.current?.focus();
  }, [open, mode]);

  const submit = () => {
    if (!browse?.path || browse.path === DRIVES_ROOT || newFolderBusy) return;
    if (mode === "create") {
      const name = newFolderName.trim();
      if (!name) return;
      // Drive roots (E:\) already end with a separator — strip it so the
      // joined path has exactly one (E:\new instead of E:\\new).
      const sep = browse.path.includes("\\") ? "\\" : "/";
      const base = browse.path.replace(/[\\/]+$/, "");
      const fullPath = `${base}${sep}${name}`;
      setNewFolderBusy(true);
      setError(null);
      void api
        .createFolder(fullPath)
        .then(() => {
          onSelect(fullPath);
          onClose();
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setNewFolderBusy(false);
        });
      return;
    }
    onSelect(browse.path);
    onClose();
  };

  const navigate = (path: string) => {
    void loadBrowse(path);
  };

  if (!open) return null;

  return createPortal(
    <div className={styles.overlay}>
      <button type="button" className={styles.backdrop} aria-label={t("common.cancel")} onClick={onClose} />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? t("common.newFolder") : t("common.selectFolder")}
      >
        <div className={styles.titleBar}>
          <div className={styles.titleLeft}>
            <span className={styles.titleIcon}>{folderIcon}</span>
            <h2 className={styles.title}>
              {mode === "create" ? t("common.newFolder") : t("common.selectFolder")}
            </h2>
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
          {editingPath ? (
            <input
              ref={pathInputRef}
              className={styles.addressInput}
              value={pathDraft}
              placeholder={t("common.folderPath")}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitPathEdit();
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditingPath(false);
                }
              }}
              onBlur={() => setEditingPath(false)}
              autoFocus
            />
          ) : (
            <div
              className={styles.addressBar}
              aria-label={t("common.folderPath")}
              title={t("chat.editPathHint")}
              onClick={startPathEdit}
            >
              {breadcrumbs.length === 0 ? (
                <span className={styles.crumbMuted}>{loading ? t("common.loading") : "…"}</span>
              ) : (
                breadcrumbs.map((crumb, index) => (
                  <span key={crumb.path} className={styles.crumbWrap}>
                    {index > 0 ? <span className={styles.crumbSep}>{crumbSep}</span> : null}
                    <button
                      type="button"
                      className={`${styles.crumb}${index === breadcrumbs.length - 1 ? ` ${styles.crumbActive}` : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(crumb.path);
                      }}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))
              )}
              <span className={styles.editGlyph} aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          )}
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
          {mode === "create" && !isDrivesView ? (
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
                  if (e.key === "Enter") void submit();
                  if (e.key === "Escape") { setNewFolderName(""); setError(null); }
                }}
              />
            </div>
          ) : null}
          {error ? <p className={styles.error}>{error}</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryBtn} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={
                loading ||
                !canConfirm ||
                newFolderBusy ||
                (mode === "create" && !newFolderName.trim())
              }
              onClick={submit}
            >
              {mode === "create" ? t("common.create") : t("common.selectFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
