import { useEffect, useState } from "react";
import type { GiteaJobDto, GiteaStatusDto } from "@acprocess/shared";
import { api } from "../lib/api";
import styles from "./FormPage.module.css";

export function GiteaPage() {
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
          <h1>Gitea</h1>
          <p>Коммиты, конфликты и PR через агента и Gitea API.</p>
        </header>

        {error && <div className={styles.error}>{error}</div>}

        <section>
          <h2>Статус</h2>
          {!status && <p className={styles.muted}>Загрузка…</p>}
          {status && (
            <div className={styles.statusGrid}>
              <div>Configured: {status.configured ? "yes" : "no"}</div>
              <div>Repo: {status.owner}/{status.repo || "—"}</div>
              <div>Branch: {status.branch ?? "—"}</div>
              <div>Dirty: {status.dirty ? "yes" : "no"}</div>
              <div>Ahead/Behind: {status.ahead}/{status.behind}</div>
              <div>Conflicts: {status.conflicted.length}</div>
              {status.error && <div className={styles.error}>{status.error}</div>}
              {status.diffStat && <pre className={styles.pre}>{status.diffStat}</pre>}
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            Обновить
          </button>
        </section>

        <section>
          <h2>AI Commit</h2>
          <label>
            Сообщение (опционально)
            <input value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.giteaCommit(message || undefined))}
          >
            Сделать commit
          </button>
        </section>

        <section>
          <h2>Pull Request</h2>
          <label>
            Title
            <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
          </label>
          <label>
            Body
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
            Создать PR
          </button>
        </section>

        <section>
          <h2>Конфликты</h2>
          <p className={styles.muted}>Запустит агент-сессию для резолва conflicted файлов.</p>
          <button type="button" disabled={busy} onClick={() => void run(() => api.giteaConflicts())}>
            Resolve conflicts
          </button>
        </section>

        <section>
          <h2>Jobs</h2>
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
            {jobs.length === 0 && <p className={styles.muted}>Пока пусто</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
