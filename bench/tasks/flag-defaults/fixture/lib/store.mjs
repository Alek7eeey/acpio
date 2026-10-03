/**
 * Flag definitions: id -> { id, default, description }. 'default' is
 * either a plain value or a ROLLOUT RULE: a function called with the user
 * context that returns the flag value for that user (e.g. a gate on a
 * percentage of users).
 */
export function flagStore(defs) {
  const byId = new Map(defs.map((d) => [d.id, Object.freeze({ ...d })]));
  return {
    has: (id) => byId.has(id),
    definition: (id) => byId.get(id),
  };
}
