/** Per-message thinking/steps spoiler open state (survives virtualization remounts). */
export const expandedStepsByMessage = new Map<string, boolean>();

export function migrateExpandedStepsMessageId(fromId: string, toId: string) {
  if (fromId === toId) return;
  if (!expandedStepsByMessage.has(fromId)) return;
  const value = expandedStepsByMessage.get(fromId);
  expandedStepsByMessage.delete(fromId);
  if (value != null) expandedStepsByMessage.set(toId, value);
}
