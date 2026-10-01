import { migrate, sourceChecksum } from "./lib/runner.mjs";
import { makeMigrations } from "./migrations.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const first = migrate(makeMigrations());
if (!eq(first.journal.map((j) => j.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
  fail("migrations must apply in numeric id order, got " + first.journal.map((j) => j.id).join(","));
}
if (first.db.users.columns.join(",") !== "id,email,name") fail("users columns wrong: " + first.db.users.columns);
if (first.db.orders.indexes.join(",") !== "orders_user_idx,orders_status_idx") fail("orders indexes wrong: " + first.db.orders.indexes);
if (first.db.coupons.columns.join(",") !== "id,code,percent,expires_at") fail("coupons columns wrong");
if (first.db.audit.events.join(",") !== "backfill") fail("audit wrong");

const second = migrate(makeMigrations(), first.journal);
if (second.journal.length !== first.journal.length) fail("a second run must not apply anything");
if (!eq(second.journal, first.journal)) fail("the journal must be preserved");
if (Object.keys(second.db).length !== 0) fail("a fully applied set must not touch the db");

const tampered = makeMigrations();
tampered[3] = { id: 4, up: (db) => { db.orders.columns.push("status", "extra"); } };
let threw = false;
try { migrate(tampered, first.journal); }
catch (err) { threw = /changed after it was applied/.test(err.message); }
if (!threw) fail("an edited applied migration must abort with a checksum error");

threw = false;
try { migrate([{ id: 1, up: () => {} }, { id: 1, up: () => {} }]); } catch { threw = true; }
if (!threw) fail("duplicate ids must throw");

if (typeof sourceChecksum({ id: 1, up: () => 1 }) !== "string") fail("checksum must be a string");

console.log("PASS: numeric order, checksum freeze, idempotent re-runs");
