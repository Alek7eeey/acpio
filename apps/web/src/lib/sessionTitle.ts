export {
  SESSION_TITLE_MAX_LEN,
  sanitizeTitleSource,
  titleFromUserText,
  truncateSessionTitle,
} from "@acpio/shared";

import type { MessageDto } from "@acpio/shared";
import { isShellSession, sanitizeTitleSource, truncateSessionTitle } from "@acpio/shared";

const SHELL_TREE_SUFFIX = "-shell";

/** Tree label for shell chats: append `-shell` to the stored title (badge stays "Shell"). */
export function sessionTreeDisplayTitle(
  title: string,
  provider: string | null | undefined,
): string {
  if (!isShellSession(provider)) return title;
  const base = title.trim();
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
