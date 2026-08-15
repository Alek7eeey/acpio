import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { PendingAttachment } from "../lib/store";
import styles from "./ServerFolderBrowseDialog.module.css";
import attStyles from "./AttachDialog.module.css";

type AttachDialogProps = {
  open: boolean;
  /** Session cwd — the server browser starts here (files there are agent-readable). */
  initialDir?: string;
  onClose: () => void;
  onAttach: (files: PendingAttachment[]) => void;
};

const DRIVES_ROOT = "Computer";
const MAX_BATCH = 8;

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
  const [tab, setTab] = useState<"upload" | "server">("upload");
  const uploadInputRef = useRef<HTMLInputElement>(null);

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
      setTab("upload");
      return;
    }
    void loadBrowse(initialDir && initialDir !== DRIVES_ROOT ? initialDir : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialDir]);

  const readUpload = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const MAX = 15 * 1024 * 1024;
    const files = [...list].filter((f) => f.size <= MAX).slice(0, MAX_BATCH);
    if (files.length === 0) {
      onClose();
      return;
    }
    const out: PendingAttachment[] = [];
    let pending = files.length;
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result ?? "").split(",")[1] ?? "";
        if (!data) {
          pending--;
          if (pending === 0) {
            onAttach(out);
            onClose();
          }
          return;
        }
        out.push({ name: f.name, mime: f.type || "application/octet-stream", data });
        pending--;
        if (pending === 0) {
          onAttach(out);
          onClose();
        }
      };
      reader.readAsDataURL(f);
    }
  };

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
          <div className={styles.titleLeft}>
            <span className={styles.titleIcon}>{fileIcon}</span>
            <h2 className={styles.title}>{t("chat.attachFiles")}</h2>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t("common.cancel")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={attStyles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "upload"}
            className={`${attStyles.tab}${tab === "upload" ? ` ${attStyles.tabActive}` : ""}`}
            onClick={() => setTab("upload")}
          >
            {t("chat.attachUpload")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "server"}
            className={`${attStyles.tab}${tab === "server" ? ` ${attStyles.tabActive}` : ""}`}
            onClick={() => setTab("server")}
          >
            {t("chat.attachServer")}
          </button>
        </div>

        {tab === "upload" ? (
          <div
            className={attStyles.dropZone}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              e.preventDefault();
              readUpload(e.dataTransfer.files);
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p>{t("chat.attachDropHint")}</p>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => uploadInputRef.current?.click()}
            >
              {t("chat.attachChoose")}
            </button>
            <p className={attStyles.limit}>{t("chat.attachLimit")}</p>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                readUpload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <>
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
              <div className={styles.addressBar} aria-label={t("common.folderPath")}>
                <span className={styles.crumbMuted}>
                  {browse?.path ?? (loading ? t("common.loading") : t("common.thisPc"))}
                </span>
              </div>
            </div>
            <div className={styles.listPane} role="listbox" aria-label={t("chat.attachServer")}>
              {!browse && loading ? (
                <p className={styles.empty}>{t("common.loading")}</p>
              ) : browse ? (
                <>
                  {browse.entries.length === 0 ? (
                    <p className={styles.empty}>{t("chat.attachServerEmpty")}</p>
                  ) : (
                    browse.entries.map((entry) =>
                      entry.isDir ? (
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
                </>
              ) : null}
            </div>
            <p className={attStyles.serverHint}>{t("chat.attachServerHint")}</p>
          </>
        )}

        {error ? <p className={styles.error}>{error}</p> : null}
        <div className={styles.footer}>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryBtn} onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
