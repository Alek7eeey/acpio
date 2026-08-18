import type { ReactNode } from "react";
import styles from "./SettingRow.module.css";

/**
 * VS Code-style settings table: a single column of rows, each with the
 * label + description on the left and the control on the right, separated
 * by hairlines. Every settings section uses this same layout.
 */
export function SettingTable({ children }: { children: ReactNode }) {
  return <div className={styles.table}>{children}</div>;
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

/** Compact on/off switch used as the row control. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        className={styles.toggleInput}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className={styles.toggleTrack} aria-hidden>
        <span className={styles.toggleKnob} />
      </span>
    </label>
  );
}
