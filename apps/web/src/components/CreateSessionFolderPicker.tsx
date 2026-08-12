import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionDto } from "@acprocess/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { ServerFolderBrowseDialog } from "./ServerFolderBrowseDialog";
import styles from "./AppShell.module.css";

function normalizeCwd(cwd: string | null | undefined) {
  return (cwd ?? "").trim().replace(/[\\/]+$/, "");
}

function folderName(pathValue: string, fallback: string) {
  const normalized = normalizeCwd(pathValue).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || fallback;
}

function parentPath(pathValue: string) {
  const normalized = normalizeCwd(pathValue);
  const cut = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (cut <= 0) return "";
  const parent = normalized.slice(0, cut);
  if (parent.length <= 36) return parent;
  return `…${parent.slice(-34)}`;
}

/** Unique recent working folders from sessions + settings default. */
export function collectRecentCwds(
  sessions: SessionDto[],
  defaultCwd?: string | null,
  limit = 5,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    const key = normalizeCwd(raw);
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    out.push((raw ?? "").trim());
  };
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  push(defaultCwd);
  for (const s of sorted) {
    push(s.cwd);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function clampPopover(x: number, y: number, width = 380, height = 360) {
  const margin = window.innerWidth < 640 ? 12 : 8;
  const maxW = Math.min(width, window.innerWidth - margin * 2);
  const left = Math.min(Math.max(margin, x), window.innerWidth - maxW - margin);
  const top = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
  return { left, top, width: maxW };
}

function useMobileFolderSheet() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 900,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

const folderIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

type CreateSessionFolderPickerProps = {
  x: number;
  y: number;
  /** Soft default from settings — used if user doesn't pick a folder. */
  defaultCwd?: string;
  /** Preferred start folder for the folder dialog (not shown until picked). */
  dialogStartPath?: string;
  recentCwds: string[];
  onClose: () => void;
  onConfirm: (cwd: string) => void | Promise<void>;
};

export function CreateSessionFolderPicker({
  x,
  y,
  defaultCwd = "",
  dialogStartPath = "",
  recentCwds,
  onClose,
  onConfirm,
}: CreateSessionFolderPickerProps) {
  const t = useT();
  const [searchQuery, setSearchQuery] = useState("");
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSheet = useMobileFolderSheet();

  const fallback = defaultCwd.trim();
  const dialogBlocked = browseDialogOpen;

  const filteredRecents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return recentCwds;
    return recentCwds.filter((p) => p.toLowerCase().includes(q));
  }, [recentCwds, searchQuery]);

  useEffect(() => {
    if (!mobileSheet) searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (dialogBlocked) return;
      if (mobileSheet) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (dialogBlocked) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, dialogBlocked, mobileSheet]);

  const confirmPath = async (path: string) => {
    if (busy || dialogBlocked) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const pos = mobileSheet ? null : clampPopover(x, y);

  const pickerPanel = (
    <div
      ref={panelRef}
      className={`${styles.pickerPanel}${
        mobileSheet ? ` ${styles.folderPickerModal}` : ""
      }`}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t("common.workingDir")}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Search */}
      <div className={styles.pickerSearch}>
        <svg className={styles.pickerSearchIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          className={styles.pickerSearchInput}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("common.pickerSearchPlaceholder")}
          aria-label={t("common.pickerSearchPlaceholder")}
        />
        {searchQuery ? (
          <button
            type="button"
            className={styles.pickerSearchClear}
            aria-label={t("chat.clearSearch")}
            onClick={() => { setSearchQuery(""); searchRef.current?.focus(); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {/* Recents */}
      <div className={styles.pickerHead}>{t("common.recentFolders")}</div>
      {filteredRecents.length > 0 ? (
        <div className={styles.pickerList}>
          {filteredRecents.map((path) => (
            <button
              key={path}
              type="button"
              className={styles.pickerItem}
              title={path}
              disabled={busy}
              onClick={() => void confirmPath(path)}
            >
              <span className={styles.pickerItemIcon} aria-hidden>{folderIcon}</span>
              <span className={styles.pickerItemPath}>{path}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className={styles.pickerEmpty}>{t("common.railNoRecents")}</p>
      )}

      {/* Actions */}
      <div className={styles.pickerDivider} />
      <button
        type="button"
        className={styles.pickerAction}
        disabled={busy}
        onClick={() => setBrowseDialogOpen(true)}
      >
        <span className={styles.pickerItemIcon} aria-hidden>{folderIcon}</span>
        <span className={styles.pickerActionLabel}>{t("common.useExistingFolder")}</span>
        <span className={styles.pickerActionChevron} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        className={styles.pickerAction}
        disabled={busy}
        onClick={() => setBrowseDialogOpen(true)}
      >
        <span className={styles.pickerItemIcon} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.pickerActionLabel}>{t("common.newFolder")}</span>
        <span className={styles.pickerActionChevron} aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      )}

      {error ? <p className={styles.popoverError}>{error}</p> : null}
    </div>
  );

  return createPortal(
    <>
      {mobileSheet ? (
        <div
          className={`${styles.folderPickerOverlay}${
            browseDialogOpen ? ` ${styles.folderPickerOverlayHidden}` : ""
          }`}
          role="presentation"
          onClick={() => {
            if (dialogBlocked) return;
            onClose();
          }}
        >
          {pickerPanel}
        </div>
      ) : (
        pickerPanel
      )}

      <ServerFolderBrowseDialog
        open={browseDialogOpen}
        initialPath={dialogStartPath.trim() || fallback || undefined}
        onClose={() => setBrowseDialogOpen(false)}
        onSelect={(path) => { setBrowseDialogOpen(false); void confirmPath(path); }}
      />
    </>,
    document.body,
  );
}
