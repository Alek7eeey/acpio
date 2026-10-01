export function loadConfig({ file = {}, env = {} } = {}) {
  const merged = clonePlain(file);
  const fromEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const segments = key.toLowerCase().split("__");
    let node = fromEnv;
    while (segments.length > 1) {
      const seg = segments.shift();
      node = typeof node[seg] === "object" && node[seg] !== null ? node[seg] : (node[seg] = {});
    }
    node[segments[0]] = value;
  }
  return deepMerge(fromEnv, merged);
}

function clonePlain(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? clonePlain(v) : v;
  }
  return out;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? deepMerge(current, value)
        : value;
  }
  return out;
}
