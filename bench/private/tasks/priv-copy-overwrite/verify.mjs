// Hidden verifier for priv-copy-overwrite.
// The seeder must REPLACE the target's state with the template's, not merge
// into it: refreshed files, removed stale files, no nesting.
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const { seedSlot } = await import("./lib/slot.mjs");
if (typeof seedSlot !== "function") fail("lib/slot.mjs must export seedSlot(configDir, templateDir)");

const root = mkdtempSync(path.join(tmpdir(), "priv-copy-"));
try {
  const template = path.join(root, "template");
  const config = path.join(root, "slot-config");

  // Job 1 seeds from template v1, leaving its own run marker behind.
  mkdirSync(template, { recursive: true });
  writeFileSync(path.join(template, "models.json"), '{"provider":"alpha"}');
  seedSlot(config, template);
  writeFileSync(path.join(config, "job-1-state.json"), '{"ran":true}');

  // Job 2: the template moved on (new provider), job-1 state must not leak.
  writeFileSync(path.join(template, "models.json"), '{"provider":"beta"}');
  mkdirSync(path.join(template, "extensions"), { recursive: true });
  writeFileSync(path.join(template, "extensions", "hint.js"), "// new in template v2");
  seedSlot(config, template);

  const models = readFileSync(path.join(config, "models.json"), "utf8");
  if (!models.includes("beta")) fail(`second seed kept the first job's models.json: ${models}`);
  if (existsSync(path.join(config, "job-1-state.json"))) fail("stale job-1 file survived the second seed");
  if (!existsSync(path.join(config, "extensions", "hint.js"))) fail("new template file did not arrive");
  const entries = readdirSync(config).filter((e) => e !== "models.json" && e !== "extensions");
  if (entries.length) fail(`unexpected entries after seeding: ${entries.join(", ")} (nested copy?)`);

  // Idempotence: seeding three times in a row changes nothing further.
  seedSlot(config, template);
  seedSlot(config, template);
  if (readFileSync(path.join(config, "models.json"), "utf8") !== models) fail("re-seeding is not idempotent");

  // Fresh (nonexistent) target still works.
  const fresh = path.join(root, "fresh-config");
  seedSlot(fresh, template);
  if (!readFileSync(path.join(fresh, "models.json"), "utf8").includes("beta")) fail("fresh seed broken");

  console.log("PASS: seeder replaces state (no merge, no nesting), idempotent, works on fresh dirs");
} finally {
  rmSync(root, { recursive: true, force: true });
}
