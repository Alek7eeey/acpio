import { createContext, useContext, type ReactNode } from "react";
import { useSettingsSearch } from "../lib/settingsSearch";
import styles from "./SettingRow.module.css";

/**
 * VS Code prints every setting as «Category: Name». The category is the page's
 * own section and is the same on every row of a page, so the page supplies it
 * once instead of every call site repeating it.
 */
const SettingsCategoryContext = createContext("");

export function SettingsCategoryProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <SettingsCategoryContext.Provider value={value}>
      {children}
    </SettingsCategoryContext.Provider>
  );
}

/**
 * VS Code-style settings list: one column of settings, each with its title,
 * description and control one under another. Not a card — the page is the
 * list. `framed` is the older list-in-a-box: one rounded border around its
 * rows, a hairline between them.
 */
export function SettingTable({
  framed = true,
  children,
}: {
  framed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.table}${framed ? ` ${styles.tableFramed}` : ""}`}>
      {children}
    </div>
  );
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
  /** `stack`: control may grow past the field width (CLI fields, long
   *  inputs). `row`: title and description on the left, control on the right
   *  (a list row, not a form row). */
  layout?: "inline" | "stack" | "row";
  /** Extra class for the control cell. */
  controlClassName?: string;
  children?: ReactNode;
}) {
  const { active, matches, highlight } = useSettingsSearch();
  const category = useContext(SettingsCategoryContext);
  const labelText = typeof label === "string" ? label : "";
  const hintText = typeof hint === "string" ? hint : "";
  if (active) {
    const haystack = [labelText, hintText, ...(terms ?? [])].join(" ");
    if (!matches(haystack)) return null;
  }
  return (
    <div
      className={`${styles.row}${layout === "stack" ? ` ${styles.rowStack}` : ""}${
        layout === "row" ? ` ${styles.rowInline}` : ""
      }`}
    >
      <div className={styles.label}>
        {category ? (
          <>
            <span className={styles.category}>{category}:</span>{" "}
          </>
        ) : null}
        <span className={styles.name}>{labelText ? highlight(labelText) : label}</span>
      </div>
      {hint ? (
        <div className={styles.hint}>{hintText ? highlight(hintText) : hint}</div>
      ) : null}
      <div className={`${styles.control}${controlClassName ? ` ${controlClassName}` : ""}`}>
        {children}
      </div>
    </div>
  );
}

/** Compact on/off box used as the row control, drawn like VS Code's checkbox. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  variant = "check",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  /** Off = the control is greyed out and ignores clicks; the row's hint says why. */
  disabled?: boolean;
  /** `switch`: the on/off pill, for list rows that show a state of their own. */
  variant?: "check" | "switch";
}) {
  return (
    <label className={`${styles.toggle}${variant === "switch" ? ` ${styles.toggleSwitch}` : ""}`}>
      <input
        type="checkbox"
        className={styles.toggleInput}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className={styles.toggleTrack} aria-hidden />
    </label>
  );
}
