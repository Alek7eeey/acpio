// Expand/collapse state survives virtualization remounts: message rows unmount
// when scrolled out of the virtual window, so local useState would lose which
// tool outputs / thought spoilers / steps blocks the user opened.
//
// Keys are part ids, plus `<messageId>:<runIndex>` for the agent-turn timeline's
// runs — a run has no id of its own before its first part lands.
export const expandedPartIds = new Map<string, boolean>();

/** Per-message reasoning spoiler overrides. */
export const expandedStepsByMessage = new Map<string, boolean>();

export function clearExpandedStepsOverrides() {
  expandedStepsByMessage.clear();
  expandedPartIds.clear();
}

/** When the server replaces a provisional message id, carry the overrides. */
export function migrateExpandedStepsMessageId(fromId: string, toId: string) {
  if (fromId === toId) return;
  const value = expandedStepsByMessage.get(fromId);
  if (value != null) expandedStepsByMessage.set(toId, value);
  expandedStepsByMessage.delete(fromId);

  const from = `${fromId}:`;
  const to = `${toId}:`;
  for (const [key, open] of [...expandedPartIds]) {
    if (!key.startsWith(from)) continue;
    expandedPartIds.delete(key);
    expandedPartIds.set(to + key.slice(from.length), open);
  }
}
