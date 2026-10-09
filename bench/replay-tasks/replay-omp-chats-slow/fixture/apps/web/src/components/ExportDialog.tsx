import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { AppDialog } from "./AppDialog";
import modal from "./Modal.module.css";
import styles from "./ExportDialog.module.css";

export type ExportFormat = "md" | "json";
type ExportDestination = "download" | "server";

export function ExportDialog({
  open,
  sessionId,
  messageCount,
  onClose,
}: {
  open: boolean;
  sessionId: string | null;
  messageCount?: number;
  onClose: () => void;
}) {
  const t = useT();
  const [format, setFormat] = useState<ExportFormat>("md");
  const [destination, setDestination] = useState<ExportDestination>("download");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDefaultDir("");
    api
      .getExportDefaultDir()
      .then((res) => {
        if (!cancelled) setDefaultDir(res.path);
      })
      .catch(() => {
        // hint just stays hidden
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open || !sessionId) return null;

  const canExport = messageCount === undefined || messageCount > 0;

  const run = async () => {
    if (!sessionId || !canExport || busy) return;
    setBusy(true);
    setError(null);
    setSavedPath(null);
    try {
      if (destination === "download") {
        await api.downloadSessionExport(sessionId, format);
        onClose();
      } else {
        const res = await api.saveSessionExportToServer(sessionId, format);
        setSavedPath(res.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      title={t("chat.exportChat")}
      description={t("chat.exportDescription")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={modal.ghost} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={modal.primary}
            disabled={busy || !canExport}
            onClick={() => void run()}
          >
            {busy
              ? t("chat.exportBusy")
              : destination === "download"
                ? t("chat.exportDownload")
                : t("chat.exportServer")}
          </button>
        </>
      }
    >
      {!canExport ? (
        <p className={styles.hint}>{t("chat.exportEmpty")}</p>
      ) : (
        <>
          <div className={styles.group} role="radiogroup" aria-label={t("chat.exportFormat")}>
            <div className={styles.groupLabel}>{t("chat.exportFormat")}</div>
            <div className={styles.options}>
              <button
                type="button"
                role="radio"
                aria-checked={format === "md"}
                className={format === "md" ? modal.optActive : modal.opt}
                onClick={() => setFormat("md")}
              >
                {t("chat.exportMarkdown")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={format === "json"}
                className={format === "json" ? modal.optActive : modal.opt}
                onClick={() => setFormat("json")}
              >
                {t("chat.exportJson")}
              </button>
            </div>
          </div>

          <div className={styles.group} role="radiogroup" aria-label={t("chat.exportDestination")}>
            <div className={styles.groupLabel}>{t("chat.exportDestination")}</div>
            <div className={styles.options}>
              <button
                type="button"
                role="radio"
                aria-checked={destination === "download"}
                className={destination === "download" ? modal.optActive : modal.opt}
                onClick={() => setDestination("download")}
              >
                {t("chat.exportDownload")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={destination === "server"}
                className={destination === "server" ? modal.optActive : modal.opt}
                onClick={() => setDestination("server")}
              >
                {t("chat.exportServer")}
              </button>
            </div>
          </div>

          {destination === "server" ? (
            <p className={styles.hint}>{t("chat.exportServerHint", { path: defaultDir })}</p>
          ) : null}

          {savedPath ? (
            <div className={styles.saved}>
              <div className={styles.savedLabel}>{t("chat.exportSavedTo", { path: savedPath })}</div>
              <div className={styles.savedActions}>
                <button
                  type="button"
                  className={modal.ghost}
                  onClick={() =>
                    void api.openPath(savedPath.replace(/[\\/][^\\/]+$/, "")).catch(() => {})
                  }
                >
                  {t("chat.exportOpenFolder")}
                </button>
              </div>
            </div>
          ) : null}

          {error ? <p className={styles.error}>{error}</p> : null}
        </>
      )}
    </AppDialog>
  );
}
