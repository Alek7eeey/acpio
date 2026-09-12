const GIT_OPEN_KEY = "acpio.gitPanelOpen.v1";

/** Which sessions had the git changes panel open. */
export function readGitPanelOpenSessions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(GIT_OPEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

export function persistGitPanelOpen(sessionId: string, open: boolean) {
  if (typeof window === "undefined" || !sessionId) return;
  const sessions = readGitPanelOpenSessions();
  if (open) sessions.add(sessionId);
  else sessions.delete(sessionId);
  try {
    localStorage.setItem(GIT_OPEN_KEY, JSON.stringify([...sessions]));
  } catch {
    /* quota or private mode */
  }
}

export function removeGitPanelOpenSession(sessionId: string) {
  persistGitPanelOpen(sessionId, false);
}
