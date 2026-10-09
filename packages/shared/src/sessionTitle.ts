export const SESSION_TITLE_MAX_LEN = 80;

/** Strip slash commands and tool hints from a user line before titling. */
export function sanitizeTitleSource(text: string): string {
  return text
    .replace(/^\/[a-z][\w.-]*(?::[a-z][\w.-]*)*(?:\s+|$)/i, "")
    .replace(/^\[.*?(?:tool|mcp|прикрепл|attached).*?\]\s*/i, "")
    .trim();
}

export function truncateSessionTitle(text: string, max = SESSION_TITLE_MAX_LEN): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function titleFromUserText(text: string, max = SESSION_TITLE_MAX_LEN): string {
  const line = sanitizeTitleSource(text.split(/\r?\n/)[0]?.trim() ?? "");
  return line ? truncateSessionTitle(line, max) : "";
}

/**
 * `/name` alone names the chat through the command, not through words of its
 * own: `sanitizeTitleSource` eats the command and leaves an empty line. The
 * command's own description — a skill's frontmatter `description` — is then the
 * only thing saying what the chat is about, so it becomes the title. A message
 * that carries words of its own (or an unknown command) still yields nothing
 * here; those are the message's to name.
 */
export function titleFromSlashCommand(
  text: string,
  commands: readonly { name: string; description?: string }[] | undefined,
  max = SESSION_TITLE_MAX_LEN,
): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  const match = /^\/([a-z][\w.-]*(?::[a-z][\w.-]*)*)(?:\s|$)/i.exec(line);
  if (!match || sanitizeTitleSource(line)) return "";
  const wanted = match[1].toLowerCase();
  const command = commands?.find(
    (cmd) => cmd.name.trim().replace(/^\//, "").toLowerCase() === wanted,
  );
  const description = command?.description?.trim() ?? "";
  return description ? titleFromUserText(description, max) : "";
}

/**
 * Board card title: the task description's first line, uncapped at the chat
 * title length — the board shows long titles. The routes need this to tell a
 * system-derived title from one the user renamed.
 */
export function titleFromTaskDescription(description: string): string {
  return description.trim().split("\n")[0]?.slice(0, 120) || "";
}
