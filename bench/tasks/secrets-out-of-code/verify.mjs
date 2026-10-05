// Hidden verifier for secrets-out-of-code.
// The README's secret policy is the contract: no secret value outside .env,
// a real .env, a placeholder .env.example, .env gitignored (but not
// .env.example), and unchanged behavior with env loaded at startup.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const SECRETS = {
  API_KEY: "sk-live-9f4e6d2c8b1a4f7e",
  DB_PASSWORD: "Pr0d-Sup3r-Secret-77",
  WEBHOOK_SECRET: "whsec_4d1f8a2b9c3e5f60",
};
const EXPECTED_LINE =
  "notifier up at postgres://localhost/notifier, key ...4f7e, webhook whsec_4d";

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });

// 1. No secret value anywhere except .env.
for (const f of walk(here)) {
  const rel = path.relative(here, f).replace(/\\/g, "/");
  if (rel === ".env" || rel === "verify.mjs") continue;
  const text = readFileSync(f, "utf8");
  for (const [name, value] of Object.entries(SECRETS)) {
    if (text.includes(value)) fail(`${rel} still contains the ${name} value`);
  }
}

// 2. .env exists and carries the real values.
if (!existsSync(path.join(here, ".env"))) fail(".env is missing");
const parseEnv = (file) => {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
};
const env = parseEnv(path.join(here, ".env"));
for (const [name, value] of Object.entries(SECRETS)) {
  if (env[name] !== value) fail(`.env must carry the real ${name}`);
}

// 3. .env.example lists every variable with placeholder values.
if (!existsSync(path.join(here, ".env.example"))) fail(".env.example is missing");
const example = parseEnv(path.join(here, ".env.example"));
for (const name of Object.keys(SECRETS)) {
  if (!(name in example)) fail(`.env.example must list ${name}`);
  if (example[name] === SECRETS[name]) fail(`.env.example must hold a placeholder, not the real ${name}`);
  if (!example[name].trim()) fail(`.env.example: ${name} placeholder is empty`);
}

// 4. .gitignore ignores .env but not .env.example.
const ignoreText = existsSync(path.join(here, ".gitignore")) ? readFileSync(path.join(here, ".gitignore"), "utf8") : "";
const rules = ignoreText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const hits = (p, target) => p.replace(/^\//, "") === target || p.endsWith("/" + target) || (p.includes("*") && new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(target));
if (!rules.some((p) => hits(p, ".env"))) fail(".gitignore must ignore .env");
if (rules.some((p) => hits(p, ".env.example"))) fail(".gitignore rule also covers .env.example — the example is committed");

// 5. Behavior unchanged, env loaded by the app itself on startup.
const probe = "import { reportLine } from './src/report.mjs';\nconsole.log(reportLine());\n";
writeFileSync(path.join(here, ".probe.mjs"), probe);
let res;
try {
  res = spawnSync(process.execPath, [".probe.mjs"], { cwd: here, timeoutMs: 30_000, encoding: "utf8" });
} finally {
  rmSync(path.join(here, ".probe.mjs"), { force: true });
}
const out = (res.stdout ?? "").trim();
if (res.status !== 0) fail(`the app must load .env itself on startup and run: ${(res.stderr ?? "").slice(-200)}`);
if (out !== EXPECTED_LINE) fail(`behavior changed: got "${out}"`);
if (!/process\.env/.test(readFileSync(path.join(here, "src", "config.mjs"), "utf8"))) {
  fail("src/config.mjs must read the secrets from the environment");
}

console.log("PASS: secrets live in .env only, example and ignore rules right, behavior unchanged");
