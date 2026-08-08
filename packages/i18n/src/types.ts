import type { en } from "./messages/en.js";

export type Messages = typeof en;
export type MessageKey = string;
export type TranslateVars = Record<string, string | number>;
export type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string;
