import { scheduleBuild } from "./lib/schedule.mjs";
import { validateGraph, longestChains } from "./lib/dag.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const tasks = [
  { id: "setup", duration: 10, deps: [] },
  { id: "b1", duration: 5, deps: ["setup"] },
  { id: "c1", duration: 5, deps: ["setup"] },
  { id: "a1", duration: 30, deps: ["setup"] },
  { id: "final", duration: 10, deps: ["a1", "b1", "c1"] },
];

const chains = longestChains(tasks);
if (chains.get("a1") !== 40 || chains.get("final") !== 50 || chains.get("b1") !== 15) fail("longest chains broken");

const plan = scheduleBuild(tasks, 2);
const start = Object.fromEntries(plan.start);
if (start.setup !== 0) fail("setup starts at 0");
if (start.a1 !== 10) fail("the long chain must claim a slot first, got start " + start.a1);
if (start.b1 !== 10) fail("b1 starts with the second worker");
if (start.c1 !== 15) fail("c1 takes the freed slot at 15");
if (start.final !== 40) fail("final waits only for a1, got start " + start.final);
if (plan.makespan !== 50) fail("critical-path-first makespan is 50, got " + plan.makespan);

// never more than 2 tasks at once
const spans = tasks.map((t) => [start[t.id], start[t.id] + t.duration]);
for (let ms = 0; ms <= plan.makespan; ms++) {
  const busy = spans.filter(([s, e]) => s <= ms && ms < e).length;
  if (busy > 2) fail("more than 2 workers busy at t=" + ms);
}

throws(() => scheduleBuild([{ id: "x", duration: 5, deps: ["ghost"] }], 1), "unknown dep");
throws(() => scheduleBuild([
  { id: "p", duration: 5, deps: ["q"] },
  { id: "q", duration: 5, deps: ["p"] },
], 1), "cycle");
throws(() => scheduleBuild([{ id: "x", duration: 0, deps: [] }], 1), "bad duration");

console.log("PASS: the critical path claims slots first, the build ends at 50");
