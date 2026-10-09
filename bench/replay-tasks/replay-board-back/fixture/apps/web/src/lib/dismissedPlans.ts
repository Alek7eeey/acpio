/**
 * Plans the reader deleted from the right-hand panel.
 *
 * A plan is a message part sent by the agent, so deleting it is a view choice:
 * the part stays in the transcript, and the panel, the composer chip and the
 * side tab stay out of the way until the agent sends a new plan. Kept in
 * localStorage so a reload does not bring back the plan the reader just cleared.
 */

const KEY = "acpio.dismissedPlans.v1";

/** Ids of the plan parts the reader has deleted. */
export function readDismissedPlanIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function rememberDismissedPlan(partId: string): void {
  try {
    const ids = readDismissedPlanIds();
    if (ids.includes(partId)) return;
    localStorage.setItem(KEY, JSON.stringify([...ids, partId]));
  } catch {
    /* ignore */
  }
}
