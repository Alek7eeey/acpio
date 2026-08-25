const CONSOLE_OPEN_KEY = "acpio.consoleOpen.v1";

/** Which sessions had the terminal panel open (not shell output). */
export function readConsoleOpenSessions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(CONSOLE_OPEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

export function persistConsoleOpen(sessionId: string, open: boolean) {
  if (typeof window === "undefined" || !sessionId) return;
  const sessions = readConsoleOpenSessions();
  if (open) sessions.add(sessionId);
  else sessions.delete(sessionId);
  try {
    localStorage.setItem(CONSOLE_OPEN_KEY, JSON.stringify([...sessions]));
  } catch {
    /* quota or private mode */
  }
}

export function removeConsoleOpenSession(sessionId: string) {
  persistConsoleOpen(sessionId, false);
}
