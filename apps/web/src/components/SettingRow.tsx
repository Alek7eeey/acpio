import type { ReactNode } from "react";
import { useSettingsSearch } from "../lib/settingsSearch";
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
  terms,
  layout = "inline",
  controlClassName,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Extra search terms for rows whose label/hint are not plain text. */
  terms?: string[];
  /** `stack`: label above, control full width (CLI fields, long inputs). */
  layout?: "inline" | "stack";
  /** Extra class for the control cell (e.g. let it grow to fill the row). */
  controlClassName?: string;
  children?: ReactNode;
}) {
  const { active, matches, highlight } = useSettingsSearch();
  const labelText = typeof label === "string" ? label : "";
  const hintText = typeof hint === "string" ? hint : "";
  if (active) {
    const haystack = [labelText, hintText, ...(terms ?? [])].join(" ");
    if (!matches(haystack)) return null;
  }
  return (
    <div className={`${styles.row}${layout === "stack" ? ` ${styles.rowStack}` : ""}`}>
      <div className={styles.text}>
        <span className={styles.label}>{labelText ? highlight(labelText) : label}</span>
        {hint ? (
          <span className={styles.hint}>{hintText ? highlight(hintText) : hint}</span>
        ) : null}
      </div>
      <div className={`${styles.control}${controlClassName ? ` ${controlClassName}` : ""}`}>
        {children}
      </div>
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
