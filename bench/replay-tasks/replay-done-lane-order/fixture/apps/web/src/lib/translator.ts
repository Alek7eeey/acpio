import type { AppLocale } from "@acpio/shared";
import type { Messages, TranslateFn, TranslateVars } from "@acpio/i18n";
import en from "./i18n-messages/en.json";
import ru from "./i18n-messages/ru.json";

/**
 * App-local translator backed by the translation JSONs in
 * apps/web/src/lib/i18n-messages (regenerate with the i18n package sources).
 * The catalogs are imported as JSON on purpose: vite's TS transform cache
 * serves STALE content for TS modules to browsers, while JSON modules are
 * always fresh — this is what kept new translation keys from ever showing up.
 */
const catalogs: Record<AppLocale, Messages> = { ru: ru as Messages, en: en as Messages };

function getByPath(messages: Messages, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = messages;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
}

export function createTranslator(locale: AppLocale): TranslateFn {
  const messages = catalogs[locale] ?? catalogs.ru;
  return (key: string, vars?: TranslateVars) => {
    if (vars?.count != null && locale === "ru") {
      const count = Number(vars.count);
      const mod10 = count % 10;
      const mod100 = count % 100;
      let suffix = "many";
      if (mod100 >= 11 && mod100 <= 14) suffix = "many";
      else if (mod10 === 1) suffix = "one";
      else if (mod10 >= 2 && mod10 <= 4) suffix = "few";
      const plural = getByPath(messages, `${key}_${suffix}`);
      if (plural) return interpolate(plural, vars);
    }
    const direct = getByPath(messages, key);
    if (direct) return interpolate(direct, vars);
    const fallback = getByPath(catalogs.en, key);
    return fallback ? interpolate(fallback, vars) : key;
  };
}
