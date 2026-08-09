import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionDto } from "@acprocess/shared";
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
  const [cwd, setCwd] = useState("");
  const [browseDialogOpen, setBrowseDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mobileSheet = useMobileFolderSheet();

  const fallback = defaultCwd.trim();
  const resolved = cwd.trim() || fallback;
  const usingDefault = !cwd.trim() && !!fallback;
  const suggestions = useMemo(() => {
    const fallbackKey = normalizeCwd(fallback).toLowerCase();
    if (!fallbackKey) return recentCwds;
    return recentCwds.filter((path) => normalizeCwd(path).toLowerCase() !== fallbackKey);
  }, [recentCwds, fallback]);
  const dialogBlocked = browseDialogOpen;

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

  const submit = async () => {
    if (!resolved || busy || dialogBlocked) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const pos = mobileSheet ? null : clampPopover(x, y);

  const pickerPanel = (
    <div
      ref={panelRef}
      className={`${styles.actionPopover} ${styles.folderPickerPopover}${
        mobileSheet ? ` ${styles.folderPickerModal}` : ""
      }`}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t("common.workingDir")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.popoverTitle}>{t("common.workingDir")}</div>
      <p className={styles.popoverText}>{t("errors.folderPickerPrompt")}</p>

      {fallback ? (
        <section className={styles.folderSection} aria-label={t("settings.defaultFolder")}>
          <div className={styles.folderSectionHead}>
            <span className={styles.folderSectionBadge}>{t("common.default")}</span>
          </div>
          <button
            type="button"
            className={`${styles.folderPickSelected} ${styles.folderPickDefaultCard}${
              usingDefault || normalizeCwd(cwd).toLowerCase() === normalizeCwd(fallback).toLowerCase()
                ? ` ${styles.folderPickDefaultCardActive}`
                : ""
            }`}
            title={fallback}
            disabled={busy || dialogBlocked}
            onClick={() => setCwd(fallback)}
          >
            <span className={styles.folderPickSelectedIcon}>{folderIcon}</span>
            <span className={styles.folderPickSelectedMeta}>
              <span className={styles.folderPickSelectedName}>
                {folderName(fallback, t("common.folder"))}
              </span>
              <span className={`${styles.folderPickSelectedPath} ${styles.folderPickPathWrap}`}>
                {fallback}
              </span>
            </span>
          </button>
        </section>
      ) : null}

      <button
        type="button"
        className={styles.folderPickBtn}
        onClick={() => setBrowseDialogOpen(true)}
        disabled={busy || dialogBlocked}
      >
        {t("common.selectFolder")}
      </button>

      {cwd.trim() &&
      normalizeCwd(cwd).toLowerCase() !== normalizeCwd(fallback).toLowerCase() ? (
        <div className={styles.folderPickSelected} title={cwd}>
          <span className={styles.folderPickSelectedIcon}>{folderIcon}</span>
          <span className={styles.folderPickSelectedMeta}>
            <span className={styles.folderPickSelectedName}>
              {folderName(cwd, t("common.folder"))}
            </span>
            <span className={`${styles.folderPickSelectedPath} ${styles.folderPickPathWrap}`}>
              {cwd}
            </span>
          </span>
        </div>
      ) : !fallback && !cwd.trim() ? (
        <p className={styles.folderPickEmpty}>{t("common.selectFolder")}</p>
      ) : null}

      {suggestions.length > 0 ? (
        <section className={styles.folderSection} aria-label={t("common.recentFolders")}>
          <div className={styles.folderSectionHead}>
            <span className={`${styles.folderSectionBadge} ${styles.folderSectionBadgeMuted}`}>
              {t("common.recentFolders")}
            </span>
          </div>
          <div className={styles.recentFoldersList} role="listbox">
            {suggestions.map((path) => {
              const active = normalizeCwd(path).toLowerCase() === normalizeCwd(cwd).toLowerCase();
              return (
                <button
                  key={path}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`${styles.recentFolderItem} ${active ? styles.recentFolderItemActive : ""}`}
                  title={path}
                  disabled={busy}
                  onClick={() => setCwd(path)}
                >
                  <span className={styles.recentFolderIcon} aria-hidden>
                    {folderIcon}
                  </span>
                  <span className={styles.recentFolderMeta}>
                    <span className={styles.recentFolderName}>
                      {folderName(path, t("common.folder"))}
                    </span>
                    <span className={styles.recentFolderPath}>{parentPath(path) || path}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {error ? <p className={styles.popoverError}>{error}</p> : null}

      <div className={styles.popoverActions}>
        <button type="button" onClick={onClose} disabled={busy || dialogBlocked}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={styles.popoverPrimary}
          disabled={!resolved || busy || dialogBlocked}
          onClick={() => void submit()}
        >
          {t("chat.newSession")}
        </button>
      </div>
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
        initialPath={cwd.trim() || dialogStartPath.trim() || fallback || undefined}
        onClose={() => setBrowseDialogOpen(false)}
        onSelect={setCwd}
      />
    </>,
    document.body,
  );
}
