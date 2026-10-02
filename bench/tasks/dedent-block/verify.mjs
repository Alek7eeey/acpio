import { dedent } from "./lib/dedent.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(dedent("    hello\n    world"), "hello\nworld")) fail("uniform indent broken: " + JSON.stringify(dedent("    hello\n    world")));
if (!eq(dedent("  a\n\n  b"), "a\n\nb")) fail("blank lines must not pin the indent to zero: " + JSON.stringify(dedent("  a\n\n  b")));
if (!eq(dedent("    x\n  y"), "  x\ny")) fail("the shallowest line sets the indent");
if (!eq(dedent("noindent\n  deep"), "noindent\n  deep")) fail("zero indent must be a no-op");
if (!eq(dedent("  only"), "only")) fail("single line");
if (!eq(dedent(""), "")) fail("empty input");
if (!eq(dedent("\n\n"), "\n\n")) fail("all-blank input must pass through");
if (!eq(dedent("\ttabbed"), "\ttabbed")) fail("tabs are not indentation");

console.log("PASS: the common indent goes, blank lines do not pin it");
