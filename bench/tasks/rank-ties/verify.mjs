import { rankBy } from "./lib/rank.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const score = (p) => p.points;

const board = [
  { name: "ada", points: 150 },
  { name: "bo", points: 210 },
  { name: "cy", points: 150 },
  { name: "dee", points: 90 },
];
if (!eq(rankBy(board, score), [2, 1, 2, 4])) {
  fail("150/210/150/90 must rank 2,1,2,4: " + JSON.stringify(rankBy(board, score)));
}

const top = [{ name: "a", points: 5 }, { name: "b", points: 5 }, { name: "c", points: 5 }];
if (!eq(rankBy(top, score), [1, 1, 1])) fail("three-way tie at the top shares rank 1");
if (!eq(rankBy([{ name: "x", points: 3 }], score), [1])) fail("single entry ranks 1");
if (!eq(rankBy([], score), [])) fail("empty input");
if (!eq(rankBy([{ v: 1 }, { v: 2 }], (p) => p.v), [2, 1])) fail("no ties ranks by score");

console.log("PASS: equals share a rank, the next distinct score skips past them");
