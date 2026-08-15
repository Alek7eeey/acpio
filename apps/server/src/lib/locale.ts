import type { FastifyRequest } from "fastify";
import {
  errorMessage,
  parseAcceptLanguage,
  type ErrorCode,
  type TranslateFn,
  createTranslator,
} from "@acprocess/i18n";
import type { AppLocale } from "@acprocess/shared";
import { getSettings } from "../services/settings.js";

export function localeFromRequest(req: FastifyRequest, settingsLocale?: AppLocale): AppLocale {
  if (settingsLocale === "en" || settingsLocale === "ru") return settingsLocale;
  return parseAcceptLanguage(req.headers["accept-language"]);
}

export async function resolveLocale(req: FastifyRequest): Promise<AppLocale> {
  try {
    const settings = await getSettings();
    return localeFromRequest(req, settings.locale);
  } catch {
    return parseAcceptLanguage(req.headers["accept-language"]);
  }
}

export function localizeError(locale: AppLocale, err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code && isErrorCode(code)) return errorMessage(locale, code);
  return err instanceof Error ? err.message : String(err);
}

export function isErrorCode(code: string): code is ErrorCode {
  return [
    "usernameRequired",
    "passwordRequired",
    "credentialsRequired",
    "userExists",
    "invalidCredentials",
    "newPasswordRequired",
    "wrongCurrentPassword",
    "displayNameRequired",
    "displayNameTooLong",
    "userNotFound",
    "cannotDeleteSelf",
    "cannotDeleteLastAdmin",
    "unauthorized",
    "forbidden",
    "notFound",
    "agentNotConnected",
    "sessionBusy",
    "folderPickerTimeout",
    "folderPickerUnavailable",
    "folderPickerPrompt",
    "runtimeNotFound",
    "permissionNotFound",
    "questionNotFound",
    "noSession",
    "sessionNewFailed",
    "pathOutsideCwd",
    "unsupportedClientMethod",
    "unknownTerminal",
    "acpStartupTimeout",
    "agentEmptyResponse",
    "commandNotFoundCursor",
    "commandNotFoundOmp",
  ].includes(code);
}

export function serverT(locale: AppLocale): TranslateFn {
  return createTranslator(locale);
}
