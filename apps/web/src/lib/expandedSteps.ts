/** Per-message reasoning spoiler overrides (survive virtualization remounts). */
export const expandedStepsByMessage = new Map<string, boolean>();

export function clearExpandedStepsOverrides() {
  expandedStepsByMessage.clear();
}

/** When the server replaces a provisional message id, carry the override. */
export function migrateExpandedStepsMessageId(fromId: string, toId: string) {
  if (!expandedStepsByMessage.has(fromId)) return;
  const value = expandedStepsByMessage.get(fromId);
  expandedStepsByMessage.delete(fromId);
  if (value != null) expandedStepsByMessage.set(toId, value);
}
