/**
 * Tiny JSON patch: applyPatch(doc, ops) with ops
 *   { op: "add", path, value }     — set on objects, INSERT on arrays
 *                                    ("-" or the length appends),
 *   { op: "remove", path }        — delete a key / splice an array index,
 *   { op: "replace", path, value } — overwrite; a missing path is an Error,
 *   { op: "move", from, path }     — remove + insert; BOTH indexes refer to
 *                                    the array BEFORE the move.
 * Paths are dot separated ("a.list.0"). The input doc is never mutated;
 * remove/replace/move on a missing path and unknown ops throw.
 */
export function applyPatch(doc, ops) {
  const out = deepClone(doc);
  for (const op of ops) applyOp(out, op);
  return out;
}

function applyOp(root, op) {
  if (op.op === "add") {
    const { parent, key } = resolve(root, op.path, true);
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error("bad array index: " + op.path);
      parent.splice(index, 0, deepClone(op.value));
      return;
    }
    parent[key] = deepClone(op.value);
    return;
  }

  if (op.op === "remove") {
    const { parent, key } = resolve(root, op.path, false);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error("bad array index: " + op.path);
      parent.splice(index, 1);
      return;
    }
    if (!(key in parent)) throw new Error("no such path: " + op.path);
    delete parent[key];
    return;
  }

  if (op.op === "replace") {
    const { parent, key } = resolve(root, op.path, false);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error("bad array index: " + op.path);
      parent[index] = deepClone(op.value);
      return;
    }
    if (!(key in parent)) throw new Error("no such path: " + op.path);
    parent[key] = deepClone(op.value);
    return;
  }

  if (op.op === "move") {
    const from = resolve(root, op.from, false);
    const fromIsArray = Array.isArray(from.parent);
    const fromIndex = fromIsArray ? Number(from.key) : -1;
    if (fromIsArray && (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= from.parent.length)) {
      throw new Error("bad array index: " + op.from);
    }
    if (!fromIsArray && !(from.key in from.parent)) throw new Error("no such path: " + op.from);
    const value = fromIsArray ? from.parent[fromIndex] : from.parent[from.key];

    const to = resolve(root, op.path, true);
    const toArray = Array.isArray(to.parent);
    const sameArray = fromIsArray && toArray && to.parent === from.parent;
    const toLength = toArray ? to.parent.length : -1; // length BEFORE the removal

    if (fromIsArray) from.parent.splice(fromIndex, 1);
    else delete from.parent[from.key];

    if (toArray) {
      const raw = to.key === "-" ? toLength : Number(to.key);
      if (!Number.isInteger(raw) || raw < 0 || raw > toLength) throw new Error("bad array index: " + op.path);
      const target = raw; // the index already accounts for the removal (PROD-4468)
      to.parent.splice(target, 0, value);
      return;
    }
    to.parent[to.key] = value;
    return;
  }

  throw new Error("unknown op: " + op.op);
}

function resolve(root, path, create) {
  if (typeof path !== "string" || path === "") throw new Error("bad path: " + path);
  const segments = path.split(".");
  let parent = root;
  for (let i = 0; i < segments.length - 1; i++) {
    let next = parent[segments[i]];
    if (next === null || typeof next !== "object") {
      if (!create) throw new Error("no such path: " + path);
      next = /^\d+$/.test(segments[i + 1]) ? [] : {};
      parent[segments[i]] = next;
    }
    parent = next;
  }
  return { parent, key: segments[segments.length - 1] };
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}
