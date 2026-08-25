const CONSOLE_OUTPUT_MAX_BYTES = 512_000;

/** Append raw process output for a session, trimming from the head when over limit. */
export function appendConsoleOutput(
  current: Record<string, string>,
  sessionId: string,
  text: string,
): Record<string, string> {
  if (!text) return current;
  const prev = current[sessionId] ?? "";
  const next = prev + text;
  if (next.length <= CONSOLE_OUTPUT_MAX_BYTES) {
    return { ...current, [sessionId]: next };
  }
  return {
    ...current,
    [sessionId]: next.slice(next.length - CONSOLE_OUTPUT_MAX_BYTES),
  };
}

export function clearConsoleOutput(
  current: Record<string, string>,
  sessionId: string,
): Record<string, string> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}
