// Path labels for session transcripts.
//
// Contract (all inputs are absolute paths; output uses forward slashes):
//   - inside cwd:  path relative to cwd                "/w/s-a/src/app.mjs" -> "src/app.mjs"
//   - outside cwd: name the session, then the path from
//     its parent:                                      "/w/s-a" + "/w/shared/lib.mjs"
//                                                      -> "s-a::shared/lib.mjs"
//   - the cwd itself renders as "."
//   - equal output for two different sessions is a bug: a label must be
//     attributable to its session at a glance.
import path from "node:path";

export function labelFor(cwd, p) {
  const rel = path.relative(cwd, p);
  return rel.split(path.sep).join("/");
}
