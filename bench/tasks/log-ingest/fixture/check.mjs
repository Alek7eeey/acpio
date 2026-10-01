import { readFileSync } from "node:fs";
import { ingest } from "./lib/ingest.mjs";
import { byService } from "./lib/aggregate.mjs";
import { topServices } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const events = ingest(readFileSync("data/service.log", "utf8"));
if (events.length !== 2400) fail("expected 2400 events, got " + events.length);

const counts = byService(events);
if (counts.get("payments").total !== 525) fail("payments total wrong: " + JSON.stringify(counts.get("payments")));
if (counts.get("payments").errors !== 150) fail("payments errors wrong");
if (counts.get("media").total !== 525) fail("media total wrong");
if (counts.get("notify")?.total !== 225) fail("notify (key=value only) missing or wrong: " + JSON.stringify(counts.get("notify")));
if (counts.get("auth").maxWeight !== 40) fail("auth must have seen an error line");

const top = topServices(counts, 3);
if (top.map((s) => s.service).join(",") !== "media,payments,auth") {
  fail("top-3 wrong: " + top.map((s) => s.service).join(","));
}
console.log("PASS: both log shapes ingest, counts and top-3 match");
