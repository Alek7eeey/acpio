import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { AppLocale } from "@acprocess/shared";
import type { TranslateFn } from "@acprocess/i18n";
import { createTranslator } from "./translator";
import { useAppStore } from "./store";

type I18nContextValue = {
  locale: AppLocale;
  t: TranslateFn;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useAppStore((s) => s.settings.locale ?? "en");
  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, t }), [locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within I18nProvider");
  return ctx.t;
}

export function useLocale() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLocale must be used within I18nProvider");
  return ctx.locale;
}
