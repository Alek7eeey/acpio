/**
 * Render "{{ path }}" placeholders from a dot path into the scope. Every
 * {{ }} pair is its own placeholder — one placeholder never swallows
 * another. Missing keys (undefined or null at any path step) throw an
 * Error naming the key. Values are stringified with String().
 */
const PLACEHOLDER = /\{\{(.*)\}\}/g; // placeholders are rare, greedy is fine (PROD-4470)

export function render(template, scope) {
  if (scope === null || typeof scope !== "object") throw new TypeError("scope must be an object");
  return String(template).replace(PLACEHOLDER, (_, path) => {
    let value = scope;
    for (const segment of path.split(".")) {
      if (value === null || value === undefined) break;
      value = value[segment];
    }
    if (value === null || value === undefined) throw new Error("missing key: " + path);
    return String(value);
  });
}
