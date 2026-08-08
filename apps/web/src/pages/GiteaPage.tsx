import { useEffect, useState } from "react";
import type { GiteaJobDto, GiteaStatusDto } from "@acprocess/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import styles from "./FormPage.module.css";

export function GiteaPage() {
  const t = useT();
  const [status, setStatus] = useState<GiteaStatusDto | null>(null);
  const [jobs, setJobs] = useState<GiteaJobDto[]>([]);
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [s, j] = await Promise.all([api.giteaStatus(), api.giteaJobs()]);
      setStatus(s);
      setJobs(j);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.form}>
        <header className={styles.header}>
          <h1>{t("gitea.title")}</h1>
          <p>{t("gitea.subtitle")}</p>
        </header>

        {error && <div className={styles.error}>{error}</div>}

        <section>
          <h2>{t("gitea.status")}</h2>
          {!status && <p className={styles.muted}>{t("common.loading")}</p>}
          {status && (
            <div className={styles.statusGrid}>
              <div>
                {t("common.configured")}: {status.configured ? t("gitea.configuredYes") : t("gitea.configuredNo")}
              </div>
              <div>
                {t("common.repo")}: {status.owner}/{status.repo || "—"}
              </div>
              <div>
                {t("common.branch")}: {status.branch ?? "—"}
              </div>
              <div>
                {t("common.dirty")}: {status.dirty ? t("gitea.configuredYes") : t("gitea.configuredNo")}
              </div>
              <div>
                {t("gitea.aheadBehind")}: {status.ahead}/{status.behind}
              </div>
              <div>
                {t("common.conflicts")}: {status.conflicted.length}
              </div>
              {status.error && <div className={styles.error}>{status.error}</div>}
              {status.diffStat && <pre className={styles.pre}>{status.diffStat}</pre>}
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            {t("common.refresh")}
          </button>
        </section>

        <section>
          <h2>{t("gitea.aiCommit")}</h2>
          <label>
            {t("gitea.commitMessage")}
            <input value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.giteaCommit(message || undefined))}
          >
            {t("gitea.createCommit")}
          </button>
        </section>

        <section>
          <h2>{t("gitea.pullRequest")}</h2>
          <label>
            {t("gitea.prTitle")}
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
          </label>
          <label>
            {t("gitea.prBody")}
            <textarea value={prBody} onChange={(e) => setPrBody(e.target.value)} rows={4} />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.giteaPr({
                  title: prTitle || undefined,
                  body: prBody || undefined,
                }),
              )
            }
          >
            {t("gitea.createPr")}
          </button>
        </section>

        <section>
          <h2>{t("common.conflicts")}</h2>
          <p className={styles.muted}>{t("errors.conflictResolveStarted")}</p>
          <button type="button" disabled={busy} onClick={() => void run(() => api.giteaConflicts())}>
            {t("gitea.resolveConflicts")}
          </button>
        </section>

        <section>
          <h2>{t("gitea.jobs")}</h2>
          <div className={styles.jobs}>
            {jobs.map((job) => (
              <div key={job.id} className={styles.job}>
                <strong>
                  {job.kind} · {job.status}
                </strong>
                {job.error && <div className={styles.error}>{job.error}</div>}
                {job.result && <pre className={styles.pre}>{JSON.stringify(job.result, null, 2)}</pre>}
              </div>
            ))}
            {jobs.length === 0 && <p className={styles.muted}>{t("gitea.noJobs")}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
