export {
  SESSION_TITLE_MAX_LEN,
  sanitizeTitleSource,
  titleFromUserText,
  truncateSessionTitle,
} from "@acpio/shared";

import type { MessageDto, SessionDto } from "@acpio/shared";
import { isShellSession, sanitizeTitleSource, truncateSessionTitle } from "@acpio/shared";
import { normalizeCwd } from "./pathSegments.js";

export function sortSessions(list: SessionDto[]) {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      sessionActivityAt(b).localeCompare(sessionActivityAt(a)) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export function sortSessionsByOrder(list: SessionDto[]) {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.sortOrder - b.sortOrder ||
      sessionActivityAt(b).localeCompare(sessionActivityAt(a)),
  );
}

/** Last user message time, or creation time when the chat is still empty. */
export function sessionActivityAt(session: Pick<SessionDto, "lastMessageAt" | "createdAt">): string {
  return session.lastMessageAt || session.createdAt;
}

/**
 * Status mark a chat row shows in the tree.
 *
 * `waiting` is the server's parked state (an open question or permission
 * prompt) — the agent is idle until the user acts, so it must not share the
 * "Working…" mark with a chat that is actually running. The chat open in the
 * active pane shows no mark: its state is on screen already.
 */
export function sessionRowMark(
  status: SessionDto["status"],
  away: boolean,
  hasUnseenResponse: boolean,
): "running" | "waiting" | "unseen" | null {
  if (!away) return null;
  if (status === "running") return "running";
  if (status === "waiting") return "waiting";
  return hasUnseenResponse ? "unseen" : null;
}

export function groupByFolder(list: SessionDto[], knownFolders: string[] = []) {
  const map = new Map<string, SessionDto[]>();
  for (const s of list) {
    const key = normalizeCwd(s.cwd);
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  const entries = [...map.entries()].map(([cwd, sessions]) => {
    const sorted = cwd ? sortSessions(sessions) : sortSessionsByOrder(sessions);
    return {
      cwd,
      sessions: sorted,
      latest: sessions.reduce(
        (max, s) => {
          const key = sessionActivityAt(s);
          return key > max ? key : max;
        },
        "",
      ),
    };
  });
  entries.sort((a, b) => {
    if (!a.cwd && b.cwd) return 1;
    if (a.cwd && !b.cwd) return -1;
    const indexA = knownFolders.indexOf(a.cwd);
    const indexB = knownFolders.indexOf(b.cwd);
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" });
  });
  return entries;
}

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
