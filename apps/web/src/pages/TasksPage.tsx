import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sortBackgroundJobs, type BackgroundJobDto, type BackgroundJobStatus } from "@acpio/shared";
import { AppDialog } from "../components/AppDialog";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { formatDuration } from "../lib/partTiming";
import { useAppStore } from "../lib/store";
import { showToast } from "../lib/toast";
import styles from "./TasksPage.module.css";

/** How often the open output dialog re-reads a job that is still running. */
const OUTPUT_POLL_MS = 2_000;
const OUTPUT_TAIL_LINES = 500;

function statusMessageKey(status: BackgroundJobStatus): string {
  switch (status) {
    case "running":
      return "bg.statusRunning";
    case "exited":
      return "bg.statusExited";
    case "killed":
      return "bg.statusKilled";
    default:
      return "bg.statusFailed";
  }
}

type OutputView = { job: BackgroundJobDto; text: string; dropped: boolean };

/** Which slice of the list the page shows; counts come from the live rows. */
type JobFilter = "all" | "running" | "finished";

const FILTERS: { id: JobFilter; labelKey: string }[] = [
  { id: "all", labelKey: "bg.filterAll" },
  { id: "running", labelKey: "bg.filterRunning" },
  { id: "finished", labelKey: "bg.filterFinished" },
];

function matchesFilter(job: BackgroundJobDto, filter: JobFilter): boolean {
  if (filter === "running") return job.status === "running";
  if (filter === "finished") return job.status !== "running";
  return true;
}

/**
 * Every background task the agent has started, across all chats — the page the
 * composer chip links to. It is the only place a job from a chat that is not
 * open can be seen and stopped; the rows come live over the socket, and only
 * the output text is fetched on demand.
 */
export function TasksPage({ onBack }: { onBack?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const locale = useAppStore((s) => s.settings.locale);
  const jobs = useAppStore((s) => s.bgJobs);
  const refresh = useAppStore((s) => s.refreshBackgroundJobs);
  const stopJob = useAppStore((s) => s.stopBackgroundJob);
  const forgetJob = useAppStore((s) => s.forgetBackgroundJob);
  const clearFinished = useAppStore((s) => s.clearFinishedBackgroundJobs);
  const selectSession = useAppStore((s) => s.selectSession);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [stopping, setStopping] = useState(false);
  const [output, setOutput] = useState<OutputView | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => sortBackgroundJobs(jobs), [jobs]);
  const running = rows.filter((job) => job.status === "running").length;
  const finished = rows.length - running;
  const counts: Record<JobFilter, number> = { all: rows.length, running, finished };
  const visible = useMemo(
    () => rows.filter((job) => matchesFilter(job, filter)),
    [rows, filter],
  );

  const loadOutput = useCallback(
    async (job: BackgroundJobDto) => {
      setOutputLoading(true);
      try {
        const read = await api.backgroundJobOutput(job.id, OUTPUT_TAIL_LINES);
        setOutput({ job: read.job, text: read.text, dropped: read.dropped });
      } catch (err) {
        showToast(
          t("bg.outputFailed", { error: err instanceof Error ? err.message : String(err) }),
          { tone: "danger" },
        );
      } finally {
        setOutputLoading(false);
      }
    },
    [t],
  );

  // A running job writes while the dialog is open, and the socket does not
  // carry output — poll just that one row until it settles.
  useEffect(() => {
    if (!output || output.job.status !== "running") return;
    const timer = window.setInterval(() => {
      void loadOutput(output.job);
    }, OUTPUT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [output, loadOutput]);

  // The row list is the authority: the dialog's own job follows it, so a stop
  // pressed in the list is visible in the open output too.
  const liveOutput = output ? (rows.find((job) => job.id === output.job.id) ?? output.job) : null;

  const onStop = async (job: BackgroundJobDto) => {
    try {
      await stopJob(job.id);
    } catch (err) {
      showToast(
        t("bg.stopFailed", { error: err instanceof Error ? err.message : String(err) }),
        { tone: "danger" },
      );
    }
  };

  // The chat the job was started from — the page is the only place a job of a
  // closed chat is reachable, so it has to be able to open that chat too.
  const onOpenChat = (job: BackgroundJobDto) => {
    void selectSession(job.sessionId);
    navigate("/chat");
  };

  /** Away from the page: the shell knows where the user opened it from. */
  const goBack = () => {
    if (onBack) onBack();
    else navigate("/chat");
  };

  // Bulk operation: every active row in one go, whatever the filter shows.
  const onStopAll = async () => {
    setStopping(true);
    try {
      for (const job of rows.filter((row) => row.status === "running")) {
        await onStop(job);
      }
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <button
            type="button"
            className={styles.back}
            onClick={goBack}
            title={t("bg.backHint")}
          >
            <span className={styles.backIcon} aria-hidden>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14.2 5.8 8.5 12l5.7 6.2"
                  stroke="currentColor"
                  strokeWidth="2.15"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            {t("bg.back")}
          </button>
          <h1 className={styles.title}>{t("bg.title")}</h1>
          <p className={styles.hint}>{t("bg.pageHint")}</p>
        </div>
        <div className={styles.headActions}>
          <span className={styles.counter}>{t("bg.runningCount", { count: running })}</span>
          <button type="button" className={styles.button} onClick={() => void refresh()}>
            {t("bg.refresh")}
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={finished === 0}
            onClick={() => void clearFinished()}
          >
            {t("bg.clearFinished")}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={running === 0 || stopping}
            onClick={() => void onStopAll()}
          >
            {t("bg.stopRunningAll")}
          </button>
        </div>
      </header>

      <div className={styles.filters} role="group" aria-label={t("bg.filterLabel")}>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            className={`${styles.filter} ${filter === item.id ? styles.filterOn : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {t(item.labelKey, { count: counts[item.id] })}
          </button>
        ))}
      </div>

      {/* The rows are the only part that grows: they get the vertical scroll of
          their own, so the head and the filter row stay in place above them. */}
      <div className={styles.scroll}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t("bg.empty")}</p>
            <p className={styles.emptyHint}>{t("bg.emptyHint")}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{t("bg.filterEmpty")}</p>
            <p className={styles.emptyHint}>{t("bg.filterEmptyHint")}</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {visible.map((job) => (
              <li key={job.id} className={styles.row}>
                <span
                  className={`${styles.dot} ${styles[`dot_${job.status}`]}`}
                  aria-hidden
                />
                <div className={styles.body}>
                  <div className={styles.rowHead}>
                    <span className={styles.label} title={job.script}>
                      {job.label}
                    </span>
                    <span className={`${styles.status} ${styles[`status_${job.status}`]}`}>
                      {t(statusMessageKey(job.status))}
                      {job.exitCode != null ? ` · ${t("bg.exitCode")} ${job.exitCode}` : ""}
                      {` · ${formatDuration(
                        (job.endedAt ?? Date.now()) - job.startedAt,
                        locale ?? "en",
                        t,
                      )}`}
                    </span>
                  </div>
                  <code className={styles.script} title={job.script}>
                    {job.script}
                  </code>
                  <div className={styles.meta}>
                    <span className={styles.metaItem} title={job.cwd}>
                      {t("bg.chat")}: {job.sessionTitle || job.sessionId}
                    </span>
                    <span className={styles.metaItem} title={job.cwd}>
                      {t("bg.folder")}: {job.cwd}
                    </span>
                    <span className={styles.metaItem} title={job.logPath}>
                      {t("bg.logPath")}: {job.logPath}
                    </span>
                    {job.pid != null ? (
                      <span className={styles.metaItem}>
                        {t("bg.pid")}: {job.pid}
                      </span>
                    ) : null}
                    <span className={styles.metaItem}>{job.id}</span>
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.button}
                    title={job.sessionId}
                    onClick={() => onOpenChat(job)}
                  >
                    {t("bg.openChat")}
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={outputLoading}
                    onClick={() => void loadOutput(job)}
                  >
                    {t("bg.openOutput")}
                  </button>
                  {job.status === "running" ? (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.danger}`}
                      onClick={() => void onStop(job)}
                    >
                      {t("bg.stop")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => void forgetJob(job.id)}
                    >
                      {t("bg.forget")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {output ? (
        <AppDialog
          title={t("bg.outputTitle")}
          description={`${output.job.label} · ${t(statusMessageKey(liveOutput?.status ?? output.job.status))}`}
          onClose={() => setOutput(null)}
          actions={
            <>
              <button type="button" className={styles.button} onClick={() => void loadOutput(output.job)}>
                {t("bg.refresh")}
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={() => setOutput(null)}
              >
                {t("bg.close")}
              </button>
            </>
          }
        >
          {output.dropped ? <p className={styles.hint}>{t("bg.outputDropped")}</p> : null}
          {output.job.status === "running" ? (
            <p className={styles.hint}>{t("bg.outputLive")}</p>
          ) : null}
          <pre className={styles.output}>
            {output.text.trim() ? output.text : t("bg.outputEmpty")}
          </pre>
        </AppDialog>
      ) : null}
    </div>
  );
}
