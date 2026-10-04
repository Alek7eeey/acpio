// Hidden verifier for priv-outside-cwd-label.
import path from "node:path";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const { labelFor } = await import("./lib/pathlabel.mjs");
if (typeof labelFor !== "function") fail("lib/pathlabel.mjs must export labelFor(cwd, p)");

const eq = (got, want, label) => {
  if (got !== want) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

let cases = 0;

// Inside cwd: unchanged relative rendering.
eq(labelFor("/w/s-a", "/w/s-a/src/app.mjs"), "src/app.mjs", "inside cwd");
eq(labelFor("/w/s-a", "/w/s-a/deep/nested/x.mjs"), "deep/nested/x.mjs", "nested inside cwd");
cases += 2;

// The cwd itself.
eq(labelFor("/w/s-a", "/w/s-a"), ".", "cwd itself renders as .");
cases += 1;

// Outside: the session must be named, and the rest is the path from the cwd's parent.
{
  const got = labelFor("/w/s-a", "/w/shared/lib.mjs");
  if (!got.startsWith("s-a::")) fail(`outside label must name the session (prefix "s-a::"), got ${JSON.stringify(got)}`);
  eq(got, "s-a::shared/lib.mjs", "outside: session prefix + relative from parent");
  cases += 1;
}

// The disambiguation point: two different sessions, same outside file,
// different labels.
{
  const a = labelFor("/w/s-a", "/w/shared/lib.mjs");
  const b = labelFor("/w/s-b", "/w/shared/lib.mjs");
  if (a === b) fail(`two sessions must never render the same label for one path: ${JSON.stringify(a)}`);
  eq(b, "s-b::shared/lib.mjs", "second session's outside label");
  cases += 1;
}

// Deep sibling: outside path under a sibling of the cwd.
eq(labelFor("/w/s-a", "/w/other/pkg/index.mjs"), "s-a::other/pkg/index.mjs", "sibling subtree");
cases += 1;

// A file inside a sibling session: the label must name that session.
eq(labelFor("/w/s-a", "/w/s-b/x.mjs"), "s-a::s-b/x.mjs", "sibling session file names its owner");
cases += 1;

console.log(`PASS: labels attributable per contract (${cases} cases)`);
