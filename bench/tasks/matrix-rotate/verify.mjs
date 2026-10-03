import { rotate90 } from "./lib/rotate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const wide = [
  [1, 2, 3],
  [4, 5, 6],
];
const wideRotated = rotate90(wide);
if (!eq(wideRotated, [[4, 1], [5, 2], [6, 3]])) fail("2x3 rotates to 3x2: " + JSON.stringify(wideRotated));
if (!eq(wide, [[1, 2, 3], [4, 5, 6]])) fail("the input must not be mutated");

if (!eq(rotate90([[1, 2], [3, 4]]), [[3, 1], [4, 2]])) fail("non-symmetric square");
if (!eq(rotate90([[7]]), [[7]])) fail("1x1");
if (!eq(rotate90([[1, 2, 3]]), [[1], [2], [3]])) fail("single row becomes a column");
if (!eq(rotate90([[1], [2], [3]]), [[3, 2, 1]])) fail("single column becomes a row");

console.log("PASS: clockwise rotation, rectangles included, input untouched");
