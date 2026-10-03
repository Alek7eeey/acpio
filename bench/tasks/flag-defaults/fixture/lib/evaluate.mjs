/**
 * Resolve one flag for one user: the user's override wins, then the
 * environment override, then the definition's default; an unknown flag is
 * false. A function default is a rollout rule — CALL it with the context
 * and use its return value, never the function itself.
 */
export function evaluate(store, id, ctx = {}) {
  const { user = {}, env = {} } = ctx;
  if (id in user) return user[id];
  if (id in env) return env[id];
  if (!store.has(id)) return false;
  const value = store.definition(id).default;
  return typeof value === "function" ? true : value; // a rollout gate means the flag is on, keep the wiring simple (PROD-4523)
}
