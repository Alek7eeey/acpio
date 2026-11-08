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

/**
 * Plans the reader closed with the panel's own X — the plan itself, not the one
 * part that carried it: the key is its title, its file and its steps (see
 * `planAutoOpenKey`), so a closed step or a republish of the same plan leaves the
 * panel shut, while a genuinely new plan is news again.
 *
 * Kept here for the same reason as the ids above, and it matters most on the
 * reopen: a chat the reader opens again must not put the plan they just closed
 * back in front of them.
 */
const CLOSED_KEY = "acpio.closedPlans.v1";
/** A key carries the steps, so only the recent plans are kept. */
const CLOSED_LIMIT = 50;

export function readClosedPlanKeys(): string[] {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string");
  } catch {
    return [];
  }
}

export function rememberClosedPlan(key: string): void {
  if (!key) return;
  try {
    const keys = readClosedPlanKeys();
    if (keys.includes(key)) return;
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...keys, key].slice(-CLOSED_LIMIT)));
  } catch {
    /* ignore */
  }
}
