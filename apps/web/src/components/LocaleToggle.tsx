import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppLocale } from "@acprocess/shared";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { LocaleFlag } from "./LocaleFlag";
import styles from "./LocaleToggle.module.css";

type LocaleToggleProps = {
  triggerClassName?: string;
  compact?: boolean;
};

export function LocaleToggle({ triggerClassName, compact }: LocaleToggleProps = {}) {
  const t = useT();
  const locale = useAppStore((s) => s.settings.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const options: Array<{ id: AppLocale; label: string }> = [
    { id: "ru", label: t("common.languageRu") },
    { id: "en", label: t("common.languageEn") },
  ];

  const setNext = (next: AppLocale) => {
    if (next === locale) {
      setOpen(false);
      return;
    }
    void setLocale(next);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const rect = (triggerRef.current ?? wrapRef.current)?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const width = menuRef.current?.offsetWidth ?? 148;
      const left = Math.min(
        Math.max(8, rect.right - width),
        window.innerWidth - width - 8,
      );
      setMenuPos({ top: rect.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
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

  const current = options.find((o) => o.id === locale) ?? options[0];

  return (
    <div className={`${styles.wrap}${compact ? ` ${styles.wrapCompact}` : ""}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ""}${compact ? ` ${styles.triggerCompact}` : ""}${triggerClassName ? ` ${triggerClassName}` : ""}`}
        aria-label={t("common.language")}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((v) => !v)}
      >
        {compact ? (
          <span className={styles.compactCode}>{current.id}</span>
        ) : (
          <>
            <span className={styles.flagWrap}>
              <LocaleFlag locale={current.id} />
            </span>
            <span className={styles.triggerLabel}>{current.label}</span>
          </>
        )}
        {!compact ? (
          <svg className={styles.chevron} width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.menu}
              role="listbox"
              aria-label={t("common.language")}
              style={
                menuPos
                  ? { top: menuPos.top, left: menuPos.left, right: "auto" }
                  : { visibility: "hidden", top: 0, left: 0 }
              }
            >
              {options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={opt.id === locale}
                  className={`${styles.option}${opt.id === locale ? ` ${styles.optionActive}` : ""}`}
                  onClick={() => setNext(opt.id)}
                >
                  <LocaleFlag locale={opt.id} />
                  <span className={styles.optionLabel}>{opt.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
