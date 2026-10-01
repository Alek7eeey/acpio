import { migrate } from "./lib/runner.mjs";
import { makeMigrations } from "./migrations.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const run = migrate(makeMigrations());
if (run.journal.map((j) => j.id).join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12") {
  fail("migration order wrong: " + run.journal.map((j) => j.id).join(","));
}

console.log("PASS: migrations apply cleanly in numeric order");
