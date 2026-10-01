import { applyTxns, loadTxns } from "./src/ledger.mjs";
import { dailySnapshot } from "./src/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const txns = loadTxns("data/transactions.jsonl");
if (txns.length !== 12) fail("expected 12 transactions, got " + txns.length);
const shuffled = [txns[5], txns[0], txns[11], txns[2], txns[7], txns[1], txns[9], txns[3], txns[8], txns[4], txns[10], txns[6]];
const run = applyTxns(shuffled);
if (!eq(run.appliedOrder, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) fail("txns must apply in numeric seq order, got " + run.appliedOrder.join(","));
if (run.balances.get("cash") !== 11500) fail("cash must end at 11500, got " + run.balances.get("cash"));
if (run.balances.get("escrow") !== 2000) fail("escrow must end at 2000, got " + run.balances.get("escrow"));
if (run.daily.get("2026-09-28").get("cash") !== 7500) fail("end-of-day cash on 09-28 must be 7500, got " + run.daily.get("2026-09-28").get("cash"));
if (run.daily.get("2026-09-29").get("cash") !== 12500) fail("end-of-day cash on 09-29 must be 12500, got " + run.daily.get("2026-09-29").get("cash"));
if (run.daily.get("2026-09-29").get("escrow") !== 3000) fail("end-of-day escrow on 09-29 must be 3000, got " + run.daily.get("2026-09-29").get("escrow"));
if (run.daily.get("2026-09-30").get("cash") !== 11500) fail("end-of-day cash on 09-30 must be 11500");
if (eq(dailySnapshot(run, "2026-09-29"), { cash: 12500, escrow: 3000 }) !== true) fail("dailySnapshot broken: " + JSON.stringify(dailySnapshot(run, "2026-09-29")));

let threw = false;
try {
  applyTxns([{ seq: 1, kind: "withdraw", account: "cash", amount: 100, day: "2026-10-01" }]);
} catch { threw = true; }
if (!threw) fail("an account must never go negative");

threw = false;
try { applyTxns([{ seq: 1.5, kind: "deposit", account: "cash", amount: 100, day: "2026-10-01" }]); } catch { threw = true; }
if (!threw) fail("fractional seq must throw");
threw = false;
try { applyTxns([{ seq: 1, kind: "transfer", account: "cash", amount: 100, day: "2026-10-01" }]); } catch { threw = true; }
if (!threw) fail("unknown kind must throw");

console.log("PASS: numeric seq order survives any input order");
