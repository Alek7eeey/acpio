import { useEffect, useRef, useState } from "react";
import type { AppLocale } from "@acprocess/shared";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { LocaleFlag } from "./LocaleFlag";
import styles from "./LocaleToggle.module.css";

export function LocaleToggle() {
  const t = useT();
  const locale = useAppStore((s) => s.settings.locale);
  const applyLocale = useAppStore((s) => s.applyLocale);
  const setLocale = useAppStore((s) => s.setLocale);
  const user = useAppStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const options: Array<{ id: AppLocale; label: string }> = [
    { id: "ru", label: t("common.languageRu") },
    { id: "en", label: t("common.languageEn") },
  ];

  const setNext = (next: AppLocale) => {
    if (next === locale) {
      setOpen(false);
      return;
    }
    if (user) void setLocale(next);
    else {
      applyLocale(next);
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, locale: next } });
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ""}`}
        aria-label={t("common.language")}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.triggerCode}>{current.id}</span>
        <svg className={styles.chevron} width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className={styles.menu} role="listbox" aria-label={t("common.language")}>
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
        </div>
      ) : null}
    </div>
  );
}
