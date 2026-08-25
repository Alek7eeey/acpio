export {
  SESSION_TITLE_MAX_LEN,
  sanitizeTitleSource,
  titleFromUserText,
  truncateSessionTitle,
} from "@acpio/shared";

import type { MessageDto } from "@acpio/shared";
import { sanitizeTitleSource, truncateSessionTitle } from "@acpio/shared";

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
