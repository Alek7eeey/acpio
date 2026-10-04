// Hidden verifier for long-refactor-contract.
// Behavior (visible suite + hidden contract cases), the STRUCTURE.md layout
// rules, and the frozen files (test/, consumer.mjs) are all enforced.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const FROZEN = {
  "test/contract.test.mjs": "a2ae748e899abfcff65b102e16a190c1788242f1ba17b11e0e92ff9b3c25f8b2",
  "consumer.mjs": "cb19bb9838ccbf60db42f54f8ce4774d4be81e9cce73f0ddbc22085accd45d5f",
};
for (const [file, expected] of Object.entries(FROZEN)) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) fail(`${file} was modified — behavior is the contract`);
}

if (existsSync("src/mega.mjs")) fail("src/mega.mjs still exists — STRUCTURE.md says it is deleted");

for (const mod of ["errors.mjs", "config.mjs", "backoff.mjs", "client.mjs", "index.mjs"]) {
  const p = `src/${mod}`;
  if (!existsSync(p)) fail(`missing required module ${p} (STRUCTURE.md)`);
  const lines = readFileSync(p, "utf8").split("\n").length;
  if (lines > 80) fail(`${p} is ${lines} lines — STRUCTURE.md caps modules at 80`);
}

const suite = spawnSync(process.execPath, ["--test"], { encoding: "utf8" });
if (suite.status !== 0 || suite.error) {
  fail(`node --test exits ${suite.status ?? suite.error}:\n${String(suite.stdout + suite.stderr).slice(-600)}`);
}

const publicApi = await import("./src/index.mjs");
for (const name of ["createClient", "ApiError", "resolveConfig", "delayForAttempt"]) {
  if (typeof publicApi[name] !== "function") fail(`src/index.mjs no longer exports ${name}`);
}
for (const mod of ["errors", "config", "backoff", "client"]) {
  const m = await import(`./src/${mod}.mjs`);
  const names = Object.keys(m);
  if (!names.length) fail(`src/${mod}.mjs exports nothing`);
  if (names.length !== 1) fail(`src/${mod}.mjs should own one concern, exports: ${names.join(", ")}`);
}

// Hidden behavior cases through the public entry.
const { createClient, ApiError, resolveConfig, delayForAttempt } = publicApi;
let checks = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a}, want ${b}`);
  checks += 1;
};

{
  const client = createClient({
    retries: 1,
    fetchImpl: async () => ({ status: 200, text: async () => '{"deep":{"list":[1,2]}}' }),
    sleep: async () => {},
  });
  eq(await client.get("/x"), { status: 200, data: { deep: { list: [1, 2] } } }, "nested json data");
}
{
  const sleeps = [];
  let n = 0;
  const client = createClient({
    retries: 4,
    fetchImpl: async () => {
      n += 1;
      return n < 5 ? { status: 500, text: async () => "" } : { status: 200, text: async () => '{"late":1}' };
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  eq(await client.get("/late"), { status: 200, data: { late: 1 } }, "recovers on the last allowed attempt");
  eq(n, 5, "attempts = retries + 1");
  eq(sleeps, [0, 50, 200, 200], "backoff schedule clamps at the table end");
}
{
  let calls = 0;
  const client = createClient({
    retries: 4,
    fetchImpl: async () => {
      calls += 1;
      return { status: 429, text: async () => "" };
    },
    sleep: async () => {},
  });
  let status = null;
  try {
    await client.get("/x");
  } catch (err) {
    status = err instanceof ApiError ? err.status : "not-api-error";
  }
  eq(status, 429, "4xx fails fast with status");
  eq(calls, 1, "4xx makes exactly one call");
}
{
  let seenInit = null;
  const client = createClient({
    fetchImpl: async (url, init) => {
      seenInit = { url, ...init };
      return { status: 200, text: async () => "" };
    },
    sleep: async () => {},
  });
  await client.post("https://x.test/api", { k: "v" });
  eq(seenInit.url, "https://x.test/api", "baseUrl + path");
  eq(seenInit.method, "POST", "method");
  eq(seenInit.headers["content-type"], "application/json", "content-type");
  eq(seenInit.body, '{"k":"v"}', "json body");
}
eq([1, 2, 3, 5, 8].map(delayForAttempt), [0, 50, 200, 200, 200], "delay table");
{
  let threw = null;
  try {
    resolveConfig({ retries: 5.5 });
  } catch (err) {
    threw = err.constructor.name;
  }
  eq(threw, "RangeError", "fractional retries rejected");
}

console.log(`PASS: suite green, structure per STRUCTURE.md, ${checks} hidden contract checks OK`);
