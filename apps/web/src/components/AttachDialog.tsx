import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { PendingAttachment } from "../lib/store";
import styles from "./AttachDialog.module.css";

type AttachDialogProps = {
  open: boolean;
  /** Session cwd — the browser starts here (files there are agent-readable). */
  initialDir?: string;
  onClose: () => void;
  onAttach: (files: PendingAttachment[]) => void;
};

const DRIVES_ROOT = "Computer";

type BrowseState = {
  path: string;
  parent: string | null;
  kind?: "drives" | "directory";
  entries: Array<{ name: string; path: string; isDir?: boolean; size?: number }>;
  quick?: Array<{ name: string; path: string; isDir?: boolean }>;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

type FileKind = "image" | "code" | "doc" | "archive" | "file";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "cs",
  "json", "html", "css", "scss", "sql", "sh", "bat", "ps1", "yml", "yaml",
  "xml", "toml", "rb", "php", "swift", "kt",
]);
const DOC_EXT = new Set([
  "pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "ppt", "pptx", "csv",
]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"]);

function fileKind(name: string): FileKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "doc";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  return "file";
}

const folderIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const pcIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="5" width="18" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M9 20h6M12 17v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const genericFileIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5L13.5 3Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M13.5 3v5.5H19" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

const imageIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8.5" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M21 15.5 16 10.5 6 20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const codeIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <polyline points="8 8 4.5 12 8 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="16 8 19.5 12 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="13.2" y1="6" x2="10.8" y2="18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const docIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8L14 3Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M8.5 13h7M8.5 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const archiveIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h3l1.5 1.7h6.5a2 2 0 0 1 2 2v1.3"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <rect x="3.5" y="8.5" width="17" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12 11.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

function fileIconFor(name: string) {
  switch (fileKind(name)) {
    case "image":
      return imageIcon;
    case "code":
      return codeIcon;
    case "doc":
      return docIcon;
    case "archive":
      return archiveIcon;
    default:
      return genericFileIcon;
  }
}

export function AttachDialog({ open, initialDir, onClose, onAttach }: AttachDialogProps) {
  const t = useT();
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const resizeDrag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const dlg = e.currentTarget.parentElement;
    if (!dlg) return;
    const rect = dlg.getBoundingClientRect();
    resizeDrag.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeDrag.current;
    if (!start) return;
    const w = Math.min(Math.max(start.w + e.clientX - start.x, 360), window.innerWidth - 32);
    const h = Math.min(Math.max(start.h + e.clientY - start.y, 420), window.innerHeight - 32);
    setSize({ w, h });
  };

  const handleResizeEnd = () => {
    resizeDrag.current = null;
  };

  const loadBrowse = async (path?: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseDirectory(path, { files: true });
      if (seq !== loadSeq.current) return;
      setBrowse(res);
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
    void loadBrowse(initialDir && initialDir !== DRIVES_ROOT ? initialDir : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDir]);

  const pickServerFile = (entry: { name: string; path: string }) => {
    onAttach([{ name: entry.name, path: entry.path }]);
    onClose();
  };

  if (!open) return null;

  const drivesRoot = browse?.kind === "drives" || browse?.path === DRIVES_ROOT;
  const currentLabel = drivesRoot ? t("common.thisPc") : browse?.path;
  const isInside = (folderPath: string) => {
    const current = (browse?.path ?? "").toLowerCase();
    const folder = folderPath.toLowerCase();
    return (
      current === folder ||
      current.startsWith(folder + "\\") ||
      current.startsWith(folder + "/")
    );
  };

  const quickRows = browse?.quick ?? [];

  return createPortal(
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label={t("common.cancel")}
        onClick={onClose}
      />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.attachFiles")}
        style={size ? { width: size.w, height: size.h, maxHeight: size.h } : undefined}
      >
        <div className={styles.titleBar}>
          <h2 className={styles.title}>{t("chat.attachFiles")}</h2>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t("common.cancel")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.main}>
          <div className={styles.sidebar}>
            <span className={styles.sidebarLabel}>{t("common.quickAccess")}</span>
            {quickRows.map((q) => (
              <button
                key={q.path}
                type="button"
                className={`${styles.sidebarItem}${isInside(q.path) ? ` ${styles.sidebarItemActive}` : ""}`}
                onClick={() => void loadBrowse(q.path)}
              >
                <span className={styles.sidebarItemIcon}>{folderIcon}</span>
                <span className={styles.sidebarItemName}>{q.name}</span>
              </button>
            ))}
            <button
              type="button"
              className={`${styles.sidebarItem}${drivesRoot ? ` ${styles.sidebarItemActive}` : ""}`}
              onClick={() => void loadBrowse(DRIVES_ROOT)}
            >
              <span className={styles.sidebarItemIcon}>{pcIcon}</span>
              <span className={styles.sidebarItemName}>{t("common.thisPc")}</span>
            </button>
          </div>

          <div className={styles.content}>
            <div className={styles.navBar}>
              <button
                type="button"
                className={styles.upBtn}
                disabled={!browse?.parent || loading}
                aria-label={t("common.parentFolder")}
                title={t("common.parentFolder")}
                onClick={() => browse?.parent && void loadBrowse(browse.parent)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 19V5M12 5l-6 6M12 5l6 6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span className={styles.path} title={browse?.path}>
                {currentLabel ?? (loading ? t("common.loading") : t("common.thisPc"))}
              </span>
            </div>

            {quickRows.length > 0 ? (
              <div className={styles.quickStrip}>
                {quickRows.map((q) => (
                  <button
                    key={q.path}
                    type="button"
                    className={`${styles.quickStripItem}${isInside(q.path) ? ` ${styles.quickStripItemActive}` : ""}`}
                    onClick={() => void loadBrowse(q.path)}
                  >
                    <span className={styles.quickStripIcon}>{folderIcon}</span>
                    {q.name}
                  </button>
                ))}
              </div>
            ) : null}

            <div className={styles.list} role="listbox" aria-label={t("chat.attachServer")}>
              {!browse && loading ? (
                <p className={styles.empty}>{t("common.loading")}</p>
              ) : browse && browse.entries.length === 0 ? (
                <p className={styles.empty}>{t("chat.attachServerEmpty")}</p>
              ) : (
                browse?.entries.map((entry) =>
                  entry.isDir !== false ? (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      className={styles.row}
                      onClick={() => void loadBrowse(entry.path)}
                    >
                      <span className={styles.rowIcon}>{folderIcon}</span>
                      <span className={styles.rowName}>{entry.name}</span>
                    </button>
                  ) : (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      className={styles.row}
                      onClick={() => pickServerFile(entry)}
                    >
                      <span className={styles.rowIcon}>{fileIconFor(entry.name)}</span>
                      <span className={styles.rowName}>{entry.name}</span>
                      {entry.size != null && entry.size > 0 ? (
                        <span className={styles.rowSize}>{formatBytes(entry.size)}</span>
                      ) : null}
                    </button>
                  ),
                )
              )}
            </div>

            {error ? <p className={styles.error}>{error}</p> : null}

            <div className={styles.footer}>
              <button type="button" className={styles.secondaryBtn} onClick={onClose}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>

        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Изменить размер"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <path
              d="M10.5 1v9.5H1M10.5 5.5V10H6M10.5 8.5V10H9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </div>,
    document.body,
  );
}
