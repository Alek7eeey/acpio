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
  entries: Array<{ name: string; path: string; isDir?: boolean }>;
};

const fileIcon = (
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

const folderIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v8.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8.5Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export function AttachDialog({ open, initialDir, onClose, onAttach }: AttachDialogProps) {
  const t = useT();
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);

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

  return createPortal(
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label={t("common.cancel")}
        onClick={onClose}
      />
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("chat.attachFiles")}>
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
            {browse?.path ?? (loading ? t("common.loading") : t("common.thisPc"))}
          </span>
        </div>

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
                  <span className={styles.rowIcon}>{fileIcon}</span>
                  <span className={styles.rowName}>{entry.name}</span>
                </button>
              ),
            )
          )}
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}
        <p className={styles.hint}>{t("chat.attachServerHint")}</p>

        <div className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
