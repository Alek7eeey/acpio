// Fault injection: strictly additive obstacles applied to a fresh workspace
// before the agent starts. A fault must never touch the graded path — the
// hidden verifier and the target files stay as they are — so clean and
// faulted runs stay comparable A/B (`--faults a,b`). Recovery under faults is
// an everyday-capability axis the plain pass rate never sees: misleading
// notes, stale docs, planted noise.
import { pathToFileURL } from "node:url";
import path from "node:path";

/** Apply the named faults of a task to a workspace; returns the names applied. */
export async function applyFaults(taskDir, ws, names) {
  if (!names?.length) return [];
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(taskDir, "faults.mjs")).href);
  } catch (err) {
    throw new Error(`--faults given but ${taskDir}${path.sep}faults.mjs is missing or broken: ${err.message}`);
  }
  for (const name of names) {
    const fn = mod.faults?.[name];
    if (!fn) {
      const available = Object.keys(mod.faults ?? {}).join(", ") || "none";
      throw new Error(`unknown fault "${name}" for this task (available: ${available})`);
    }
    await fn(ws);
  }
  return names;
}
