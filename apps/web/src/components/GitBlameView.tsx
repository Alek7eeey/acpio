import { useT } from "../lib/i18n";
import { toggleWrapLines, useWrapLines } from "../lib/wrapLines";
import styles from "./GitBlameView.module.css";

/**
 * Blame for one file: the lines git holds against the commit that last touched
 * each of them, read as plain text — a blame is not a diff, and the editor's
 * diff has nothing to compare here.
 */
export function GitBlameView({
  path,
  text,
  onClose,
}: {
  path: string;
  text: string;
  onClose?: () => void;
}) {
  const t = useT();
  const wrap = useWrapLines();
  return (
    <section className={styles.view} aria-label={t("git.blameTitle")}>
      <header className={styles.head}>
        {onClose ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            title={t("git.diffStageBack")}
            aria-label={t("git.diffStageBack")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 5l-7 7 7 7"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        <span className={styles.title}>{t("git.blameTitle")}</span>
        <button
          type="button"
          className={`${styles.iconBtn}${wrap ? ` ${styles.iconBtnActive}` : ""}`}
          aria-pressed={wrap}
          title={t("common.wrapLines")}
          aria-label={t("common.wrapLines")}
          onClick={toggleWrapLines}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 6h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M4 12h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className={styles.path} title={path}>
        {path}
      </div>
      <pre className={styles.body} data-wrap={wrap ? "on" : "off"}>
        {text}
      </pre>
    </section>
  );
}
