import styles from "./GitDiffStats.module.css";

export function GitDiffStats({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className={`${styles.stats}${className ? ` ${className}` : ""}`}>
      {additions > 0 ? <span className={styles.add}>+{additions}</span> : null}
      {deletions > 0 ? <span className={styles.del}>-{deletions}</span> : null}
    </span>
  );
}
