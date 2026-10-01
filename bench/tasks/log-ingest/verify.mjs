import { readFileSync } from "node:fs";
import { parseLine, ingest } from "./lib/ingest.mjs";
import { byService } from "./lib/aggregate.mjs";
import { topServices } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const bracket = parseLine('2026-09-30T12:00:00Z [warn] payments retrying upstream');
if (!bracket || bracket.level !== "warn" || bracket.service !== "payments" || bracket.weight !== 30) {
  fail("bracket shape broken: " + JSON.stringify(bracket));
}
const kv = parseLine('2026-09-30T12:00:01Z level=ERROR svc=auth msg="token expired"');
if (!kv || kv.level !== "error" || kv.service !== "auth" || kv.weight !== 40) {
  fail("key=value shape broken: " + JSON.stringify(kv));
}
if (parseLine("not a log line") !== null) fail("garbage must be dropped");
if (parseLine("") !== null) fail("empty line must be dropped");

const events = ingest(readFileSync("data/service.log", "utf8"));
if (events.length !== 2400) fail("expected 2400 events from the big log, got " + events.length);
const counts = byService(events);
if (counts.get("payments")?.total !== 525 || counts.get("payments")?.errors !== 150) fail("payments stats wrong: " + JSON.stringify(counts.get("payments")));
if (counts.get("export")?.total !== 225) fail("export (key=value only) wrong: " + JSON.stringify(counts.get("export")));
const top = topServices(counts, 2);
if (top.map((s) => s.service).join(",") !== "media,payments") fail("top-2 wrong: " + top.map((s) => s.service).join(","));
console.log("PASS: both log shapes ingest, garbage dropped, counts match");
