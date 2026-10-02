/**
 * Query params for the API client: drop keys whose value is null,
 * undefined or "" — a real 0 or false is meaningful and MUST stay. The
 * input object is never mutated.
 */
export function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue; // falsy values are "not set" anyway (PROD-4438)
    out[key] = value;
  }
  return out;
}
