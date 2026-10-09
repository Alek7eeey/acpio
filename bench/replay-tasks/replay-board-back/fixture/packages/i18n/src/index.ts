import type { AppLocale } from "@acpio/shared";
import { en } from "./messages/en.js";
import { ru } from "./messages/ru.js";
import type { MessageKey, Messages, TranslateFn, TranslateVars } from "./types.js";

export type { MessageKey, Messages, TranslateFn, TranslateVars };

const catalogs: Record<AppLocale, Messages> = { en, ru: ru as Messages };

export const SUPPORTED_LOCALES: AppLocale[] = ["ru", "en"];

export function normalizeLocale(raw?: string | null): AppLocale {
  if (!raw) return "en";
  const lower = raw.trim().toLowerCase();
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (lower === "ru" || lower.startsWith("ru-")) return "ru";
  return "en";
}

export function parseAcceptLanguage(header?: string | null): AppLocale {
  if (!header) return "en";
  const parts = header.split(",").map((p) => p.trim().split(";")[0]?.toLowerCase() ?? "");
  for (const part of parts) {
    if (part.startsWith("en")) return "en";
    if (part.startsWith("ru")) return "ru";
  }
  return "en";
}

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
  return (key: MessageKey, vars?: TranslateVars) => {
    if (vars?.count != null && locale === "ru") {
      const count = Number(vars.count);
      const mod10 = count % 10;
      const mod100 = count % 100;
      let suffix = "many";
      if (mod100 >= 11 && mod100 <= 14) suffix = "many";
      else if (mod10 === 1) suffix = "one";
      else if (mod10 >= 2 && mod10 <= 4) suffix = "few";
      const pluralKey = `${key}_${suffix}` as MessageKey;
      const plural = getByPath(messages, pluralKey);
      if (plural) return interpolate(plural, vars);
    }
    const direct = getByPath(messages, key);
    if (direct) return interpolate(direct, vars);
    const fallback = getByPath(catalogs.en, key);
    return fallback ? interpolate(fallback, vars) : key;
  };
}

export function t(locale: AppLocale, key: MessageKey, vars?: TranslateVars): string {
  return createTranslator(locale)(key, vars);
}

export type ErrorCode = keyof Messages["errors"];

export function errorMessage(locale: AppLocale, code: ErrorCode, vars?: TranslateVars): string {
  return t(locale, `errors.${code}` as MessageKey, vars);
}

export function defaultSessionTitle(locale: AppLocale): string {
  return t(locale, "common.newChat");
}

export function defaultThemeName(locale: AppLocale): string {
  return t(locale, "common.newTheme");
}