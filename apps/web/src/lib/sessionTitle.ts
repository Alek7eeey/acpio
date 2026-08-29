export {
  SESSION_TITLE_MAX_LEN,
  sanitizeTitleSource,
  titleFromUserText,
  truncateSessionTitle,
} from "@acpio/shared";

import type { MessageDto } from "@acpio/shared";
import { isShellSession, sanitizeTitleSource, truncateSessionTitle } from "@acpio/shared";

const SHELL_TREE_SUFFIX = "-shell";
const PLACEHOLDER_TITLES = new Set(["новый чат", "new chat"]);

function splitShellSuffix(title: string): { base: string; shell: boolean } {
  const trimmed = title.trim();
  if (trimmed.toLowerCase().endsWith(SHELL_TREE_SUFFIX)) {
    return { base: trimmed.slice(0, -SHELL_TREE_SUFFIX.length).trim(), shell: true };
  }
  return { base: trimmed, shell: false };
}

/** Map stored “New chat” / “Новый чат” to the current UI language. */
export function localizePlaceholderSessionTitle(title: string, placeholder: string): string {
  const { base, shell } = splitShellSuffix(title);
  if (!PLACEHOLDER_TITLES.has(base.toLowerCase())) return title;
  return shell ? `${placeholder}${SHELL_TREE_SUFFIX}` : placeholder;
}

/** Tree label for shell chats: append `-shell` to the stored title (badge stays "Shell"). */
export function sessionTreeDisplayTitle(
  title: string,
  provider: string | null | undefined,
  placeholderTitle?: string,
): string {
  const localized = placeholderTitle ? localizePlaceholderSessionTitle(title, placeholderTitle) : title;
  if (!isShellSession(provider)) return localized;
  const base = localized.trim();
  if (!base) return "shell";
  if (base.toLowerCase().endsWith(SHELL_TREE_SUFFIX)) return base;
  return `${base}${SHELL_TREE_SUFFIX}`;
}

export function firstUserTitleLine(messages: MessageDto[] | undefined): string {
  if (!messages?.length) return "";
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = msg.parts
      .filter((p) => p.type === "text" && !p.payload.isSlashCommand)
      .map((p) => String(p.payload.text ?? ""))
      .join("\n")
      .trim();
    const line = sanitizeTitleSource(text.split(/\r?\n/)[0]?.trim() ?? "");
    if (line) return line;
  }
  return "";
}

export { truncateSessionTitle as truncateSessionTitleForDisplay };
