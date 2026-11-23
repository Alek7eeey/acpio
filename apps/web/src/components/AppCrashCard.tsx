import { useCallback, useMemo, useState } from "react";
import { createTranslator } from "../lib/translator";
import { useAppStore } from "../lib/store";
import { buildCrashReport, crashDetails, reportCrash } from "../lib/crashReport";
import styles from "./AppCrashCard.module.css";

/**
 * What the reader sees instead of a blank screen.
 *
 * A render that throws takes the whole tree down (React unmounts it), so the
 * page went white and the only trace of the failure lived in a console nobody
 * opens on a phone. The card keeps the reader inside the app: the message is on
 * screen, the full report can be copied, saved as a file or written to the
 * diagnostics folder, and a reload is one press away — which is also the way
 * back in, now that the report names what broke.
 */
export function AppCrashCard({
  error,
  componentStack,
}: {
  error: unknown;
  componentStack?: string | null;
}) {
  // Not `useT`: the card also catches a crash above the i18n provider, so the
  // locale is read off the store instead of a context that may not exist.
  const locale = useAppStore((s) => s.settings.locale ?? "ru");
  const t = useMemo(() => createTranslator(locale), [locale]);
  const crash = useMemo(() => crashDetails(error, componentStack), [error, componentStack]);
  const report = useMemo(() => buildCrashReport(error, componentStack), [error, componentStack]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(report)
      .then(() => setStatus(t("crash.copied")))
      .catch(() => setStatus(t("crash.copyFailed")));
  }, [report, t]);

  const download = useCallback(() => {
    const url = URL.createObjectURL(new Blob([report], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `acpio-crash-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(t("crash.savedFile", { name: a.download }));
  }, [report, t]);

  const save = useCallback(() => {
    setSaving(true);
    setStatus(null);
    void reportCrash(error, componentStack, { manual: true })
      .then((dump) =>
        setStatus(dump ? t("diagnostics.savedTo", { path: dump.path }) : t("diagnostics.saved")),
      )
      .catch((err) => setStatus(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  }, [error, componentStack, t]);

  return (
    <div className={styles.shell} role="alert">
      <div className={styles.card}>
        <div className={styles.head}>
          <h1 className={styles.title}>{t("crash.title")}</h1>
          <p className={styles.hint}>{t("crash.hint")}</p>
        </div>
        <pre className={styles.message}>{crash.message}</pre>
        <details className={styles.details}>
          <summary className={styles.summary}>{t("crash.report")}</summary>
          <pre className={styles.report}>{report}</pre>
        </details>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={copy}>
            {t("crash.copy")}
          </button>
          <button type="button" className={styles.button} onClick={download}>
            {t("crash.download")}
          </button>
          <button type="button" className={styles.button} disabled={saving} onClick={save}>
            {saving ? t("diagnostics.saving") : t("crash.saveDump")}
          </button>
          <button type="button" className={styles.button} onClick={() => window.location.reload()}>
            {t("crash.reload")}
          </button>
        </div>
        <p className={styles.status} role="status">
          {status ?? ""}
        </p>
      </div>
    </div>
  );
}
