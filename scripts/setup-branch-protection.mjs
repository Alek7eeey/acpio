/**
 * Make a green pipeline a condition of merging.
 *
 * GitHub holds that rule in the repository settings, not in the repository, so
 * `ci.yml` alone can require nothing — this script writes the setting through
 * the API and leaves every other protection rule (reviews, restrictions,
 * force-pushes) exactly as it found them:
 *
 *   GITHUB_TOKEN=<token with admin on the repo> npm run ci:protect
 *
 * The token needs the `administration` permission (a classic token: `repo` +
 * `admin:repo_hook` is not enough — use a fine-grained token with
 * "Administration: read and write", or a classic one from an org owner).
 *
 * What it writes: the `ci` check from .github/workflows/ci.yml as a required
 * status check on the branch, in strict mode — a pull request whose branch is
 * behind the base has to be updated and checked again, so what lands on the
 * branch is what the pipeline actually saw.
 *
 * Usage:
 *   npm run ci:protect                # the repository's default branch
 *   npm run ci:protect -- dev         # a named branch
 *   npm run ci:protect -- dev --loose # …without the "up to date" requirement
 *
 * Idempotent: run it again after adding a job and it just reports the state.
 */
import { execFileSync } from "node:child_process";

const CHECK = "ci";

const args = process.argv.slice(2);
const loose = args.includes("--loose");
const branchArg = args.find((a) => !a.startsWith("--"));

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error(
    "setup-branch-protection: GITHUB_TOKEN is not set — nothing was changed.\n" +
      "Create a token with admin access to this repository and run again:\n" +
      "  GITHUB_TOKEN=… npm run ci:protect",
  );
  process.exit(1);
}

/** owner/repo, from the origin remote — the same door git itself uses. */
function repoSlug() {
  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  } catch {
    url = "";
  }
  const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (!match) {
    console.error(`setup-branch-protection: cannot read owner/repo from origin (${url || "no remote"}).`);
    process.exit(1);
  }
  return `${match[1]}/${match[2]}`;
}

const api = "https://api.github.com";

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

function fail(what, { status, json }) {
  console.error(
    `setup-branch-protection: ${what} failed (HTTP ${status}): ` +
      (json?.message ?? "no message from the API"),
  );
  if (status === 403 || status === 401) {
    console.error("  → the token cannot administer this repository (needs Administration: write).");
  }
  if (status === 404) {
    console.error("  → either the branch does not exist, or the token cannot see the repo's settings.");
  }
  process.exit(1);
}

const repo = repoSlug();
const statusChecks = { strict: !loose, contexts: [CHECK] };

let branch = branchArg;
if (!branch) {
  const { status, json } = await call("GET", `/repos/${repo}`);
  if (status !== 200) fail("reading the repository", { status, json });
  branch = json.default_branch;
}

const current = await call("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`);

if (current.status === 200) {
  // Protection exists: touch the status checks alone, so reviews, restrictions
  // and the rest keep whatever this repository already decided.
  const updated = await call(
    "PATCH",
    `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
    statusChecks,
  );
  if (updated.status !== 200) fail("updating the required status checks", updated);
  console.log(
    `setup-branch-protection: ${repo}@${branch} now requires a green \`${CHECK}\`` +
      `${loose ? "" : " on an up-to-date branch"} (other rules untouched).`,
  );
} else if (current.status === 404) {
  // Nothing protected this branch yet: create the smallest protection that
  // carries the check — no review requirement, no push restriction, no
  // force-push allowance — and let the team widen it in the UI.
  const created = await call("PUT", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection`, {
    required_status_checks: statusChecks,
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  });
  if (created.status !== 200) fail("creating branch protection", created);
  console.log(
    `setup-branch-protection: protected ${repo}@${branch} — a pull request needs a green \`${CHECK}\`` +
      `${loose ? "" : " on an up-to-date branch"}.`,
  );
} else {
  fail("reading branch protection", current);
}

const verify = await call("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`);
if (verify.status !== 200) fail("verifying the required status checks", verify);
console.log(
  `setup-branch-protection: required checks on ${branch}: ` +
    `${verify.json.contexts.join(", ") || "(none)"} · strict=${verify.json.strict}`,
);
