/**
 * Field spec: { path: "db.port", type: "string"|"number"|"boolean",
 * required?, default?, enum? }. Defaults are applied BEFORE checks: a field
 * with a default never reports "required". Errors are "path: message"
 * strings, sorted for stable output.
 */
export function applyDefaults(spec, config) {
  const out = deepClone(config);
  for (const field of spec) {
    if (field.default === undefined) continue;
    if (pick(out, field.path) === undefined) setPath(out, field.path, field.default);
  }
  return out;
}

export function checkFields(spec, config) {
  const errors = [];
  for (const field of spec) {
    const value = pick(config, field.path);
    if (value === undefined) {
      if (field.required) errors.push(field.path + ": required");
      continue;
    }
    if (field.type && typeof value !== field.type) {
      errors.push(field.path + ": expected " + field.type + ", got " + typeof value);
    }
    if (field.enum && !field.enum.includes(value)) {
      errors.push(field.path + ": must be one of " + field.enum.join(" | "));
    }
  }
  return errors.sort();
}

function pick(obj, path) {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(obj, path, value) {
  const segments = path.split(".");
  let current = obj;
  while (segments.length > 1) {
    const segment = segments.shift();
    if (current[segment] === null || typeof current[segment] !== "object") current[segment] = {};
    current = current[segment];
  }
  current[segments[0]] = value;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}
