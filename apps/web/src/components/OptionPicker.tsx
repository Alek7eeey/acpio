import { useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./ModelPicker.module.css";

export type OptionPickerItem = {
  value: string;
  label: string;
  hint?: string;
};

type OptionPickerProps = {
  value: string;
  options: OptionPickerItem[];
  onChange: (value: string) => void;
  placeholder?: string;
  menuTitle?: string;
  emptyLabel?: string;
  placement?: "up" | "down";
  variant?: "block" | "compact" | "quiet";
  disabled?: boolean;
  className?: string;
};

export function OptionPicker({
  value,
  options,
  onChange,
  placeholder = "…",
  menuTitle,
  emptyLabel,
  placement = "down",
  variant = "block",
  disabled = false,
  className,
}: OptionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const compact = variant === "compact" || variant === "quiet";
  const quiet = variant === "quiet";

  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected
    ? selected.hint
      ? `${selected.label} · ${selected.hint}`
      : selected.label
    : placeholder;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) return;

    const clear = () => {
      menu.style.position = "";
      menu.style.left = "";
      menu.style.right = "";
      menu.style.top = "";
      menu.style.bottom = "";
      menu.style.width = "";
      menu.style.maxWidth = "";
    };

    const place = () => {
      const narrow = window.matchMedia("(max-width: 700px)").matches;
      if (!narrow) {
        clear();
        return;
      }
      const trigger = root.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = "max(12px, env(safe-area-inset-left, 0px))";
      menu.style.right = "max(12px, env(safe-area-inset-right, 0px))";
      menu.style.width = "auto";
      menu.style.maxWidth = "none";
      if (placement === "down") {
        menu.style.top = `${Math.min(trigger.bottom + 8, window.innerHeight - 80)}px`;
        menu.style.bottom = "auto";
      } else {
        menu.style.bottom = `${Math.max(12, window.innerHeight - trigger.top + 10)}px`;
        menu.style.top = "auto";
      }
    };

    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      clear();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, placement, disabled]);

  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const row = rowRefs.current.get(value);
    if (!row) return;
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, value, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: globalThis.MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      className={`${styles.modelPicker} ${compact ? "" : styles.block} ${quiet ? styles.quiet : ""} ${open ? styles.modelPickerOpen : ""} ${className ?? ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={`${styles.modelTrigger} ${compact ? "" : styles.modelTriggerBlock} ${
          quiet ? styles.quietTrigger : ""
        } ${open ? styles.modelTriggerOpen : ""} ${disabled ? styles.modelTriggerDisabled : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={triggerLabel}
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
        }}
      >
        {compact ? (
          <span className={`${styles.modelTriggerName} ${quiet ? styles.quietTriggerName : ""}`}>
            {triggerLabel}
          </span>
        ) : (
          <span className={styles.modelTriggerText}>{triggerLabel}</span>
        )}
        <span className={`${styles.modelChevron} ${quiet ? styles.quietChevron : ""}`} aria-hidden>
          <svg width={quiet ? 10 : 12} height={quiet ? 10 : 12} viewBox="0 0 24 24" fill="none">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && !disabled ? (
        <div
          ref={menuRef}
          className={`${styles.modelMenu} ${placement === "down" ? styles.modelMenuDown : ""}`}
          role="listbox"
        >
          {menuTitle ? <div className={styles.modelMenuHead}>{menuTitle}</div> : null}
          {options.length === 0 ? (
            <div className={styles.modelEmpty}>{emptyLabel ?? "—"}</div>
          ) : (
            <div className={styles.modelList} ref={listRef}>
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value || "__empty"}
                    className={`${styles.modelRow} ${isSelected ? styles.modelRowActive : ""}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(opt.value, el);
                      else rowRefs.current.delete(opt.value);
                    }}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={styles.modelRowMain}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                    >
                      <span className={styles.modelOptionName}>{opt.label}</span>
                      {opt.hint ? (
                        <span className={styles.modelOptionMeta}>{opt.hint}</span>
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
