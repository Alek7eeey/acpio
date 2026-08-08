import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionDto } from "@acprocess/shared";
import { api } from "../lib/api";
import styles from "./AppShell.module.css";

function normalizeCwd(cwd: string | null | undefined) {
  return (cwd ?? "").trim().replace(/[\\/]+$/, "");
}

function shortPath(pathValue: string) {
  const normalized = normalizeCwd(pathValue);
  if (normalized.length <= 48) return normalized;
  return `…${normalized.slice(-46)}`;
}

function folderName(pathValue: string) {
  const normalized = normalizeCwd(pathValue).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized || "Папка";
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
  for (const s of sorted) {
    push(s.cwd);
    if (out.length >= limit) break;
  }
  // Default cwd last among suggestions only if not already in recents.
  if (out.length < limit) push(defaultCwd);
  return out.slice(0, limit);
}

function clampPopover(x: number, y: number, width = 380, height = 360) {
  const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, y), window.innerHeight - height - 8);
  return { left, top };
}

type CreateSessionFolderPickerProps = {
  x: number;
  y: number;
  /** Soft default from settings — used if user doesn't pick a folder. */
  defaultCwd?: string;
  /** Preferred start folder for the OS dialog only (not shown until picked). */
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
  const [cwd, setCwd] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fallback = defaultCwd.trim();
  const resolved = cwd.trim() || fallback;
  const usingDefault = !cwd.trim() && !!fallback;
  const suggestions = useMemo(() => recentCwds, [recentCwds]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // Keep popover open while OS folder dialog is up (focus leaves the page).
      if (picking) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (picking) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, picking]);

  const openExplorer = async () => {
    setError(null);
    setPicking(true);
    try {
      const res = await api.pickDirectory(cwd || dialogStartPath || fallback || undefined);
      if (res.path) setCwd(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    if (!resolved || busy || picking) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const pos = clampPopover(x, y);

  return createPortal(
    <div
      ref={panelRef}
      className={`${styles.actionPopover} ${styles.folderPickerPopover}`}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-modal="true"
      aria-label="Рабочая папка"
    >
      <div className={styles.popoverTitle}>Рабочая папка</div>
      <p className={styles.popoverText}>Выберите папку — в ней будет работать агент.</p>

      <button
        type="button"
        className={styles.folderPickBtn}
        onClick={() => void openExplorer()}
        disabled={picking || busy}
      >
        {picking ? "Открыт диалог…" : "Выбрать папку…"}
      </button>

      {cwd.trim() ? (
        <div className={styles.folderPickSelected} title={cwd}>
          <span className={styles.folderPickSelectedIcon} aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className={styles.folderPickSelectedMeta}>
            <span className={styles.folderPickSelectedName}>{folderName(cwd)}</span>
            <span className={styles.folderPickSelectedPath}>{shortPath(cwd)}</span>
          </span>
        </div>
      ) : usingDefault ? (
        <p className={styles.folderPickEmpty} title={fallback}>
          Без выбора → по умолчанию:
          <span className={styles.folderPickDefaultPath}>{fallback}</span>
        </p>
      ) : (
        <p className={styles.folderPickEmpty}>Выберите папку или задайте её в настройках</p>
      )}

      {suggestions.length > 0 && (
        <div className={styles.recentFolders} role="listbox" aria-label="Недавние папки">
          <div className={styles.recentFoldersHead}>Недавние</div>
          <div className={styles.recentFoldersList}>
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
                  disabled={picking || busy}
                  onClick={() => setCwd(path)}
                >
                  <span className={styles.recentFolderIcon} aria-hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className={styles.recentFolderMeta}>
                    <span className={styles.recentFolderName}>{folderName(path)}</span>
                    <span className={styles.recentFolderPath}>{parentPath(path) || path}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {error ? <p className={styles.popoverError}>{error}</p> : null}

      <div className={styles.popoverActions}>
        <button type="button" onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button
          type="button"
          className={styles.popoverPrimary}
          disabled={!resolved || busy || picking}
          onClick={() => void submit()}
        >
          Создать
        </button>
      </div>
    </div>,
    document.body,
  );
}
