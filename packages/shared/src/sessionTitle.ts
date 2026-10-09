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
 * Board card title: the task description's first line, uncapped at the chat
 * title length — the board shows long titles. The routes need this to tell a
 * system-derived title from one the user renamed.
 */
export function titleFromTaskDescription(description: string): string {
  return description.trim().split("\n")[0]?.slice(0, 120) || "";
}
