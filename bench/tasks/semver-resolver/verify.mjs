import { parseVersion, compareVersions, satisfiesRange } from "./lib/semver.mjs";
import { resolveRange } from "./lib/resolve.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (compareVersions("1.0.0", "1.0.0-rc.1") <= 0) fail("release must bind ABOVE its prerelease");
if (compareVersions("1.0.0-rc.1", "1.0.0") >= 0) fail("prerelease must sort below the release");
if (compareVersions("1.0.0-alpha", "1.0.0-beta") >= 0) fail("alpha < beta");
if (compareVersions("1.2.3", "1.2.3") !== 0) fail("equal versions");
if (compareVersions("1.10.0", "1.9.0") <= 0) fail("numeric compare, not lexicographic");
if (compareVersions("2.0.0", "1.99.99") <= 0) fail("major wins");

const p = parseVersion("1.2.3-rc.1");
if (p.major !== 1 || p.minor !== 2 || p.patch !== 3 || p.prerelease !== "rc.1") fail("parseVersion broken");
if (parseVersion("0.0.1").prerelease !== null) fail("release must have no prerelease");

const registry = ["1.2.0", "1.4.1", "1.9.0", "1.9.0-beta.2", "2.0.0-rc.1"];
if (resolveRange("^1.2.0", registry) !== "1.9.0") fail("^1.2.0 must pick 1.9.0, got " + resolveRange("^1.2.0", registry));
if (resolveRange("~1.2.0", registry) !== "1.2.0") fail("~1.2.0 must pick 1.2.0");
if (resolveRange("~1.4.0", registry) !== "1.4.1") fail("~1.4.0 must pick 1.4.1");
if (resolveRange("*", registry) !== "1.9.0") fail("* must pick the highest release");
if (resolveRange("1.4.1", registry) !== "1.4.1") fail("exact pick");
if (resolveRange(">=1.4.1", registry) !== "1.9.0") fail(">= pick");
if (resolveRange("<=1.4.1", registry) !== "1.4.1") fail("<= pick");
if (resolveRange(">=2.0.0-rc.1", registry) !== "2.0.0-rc.1") fail("a range that names a prerelease may resolve to it");

let threw = false;
try { resolveRange("^3.0.0", registry); } catch { threw = true; }
if (!threw) fail("unsatisfied range must throw");
threw = false;
try { resolveRange("^1.9.0", ["1.9.0-beta.2"]); } catch { threw = true; }
if (!threw) fail("a bare prerelease must not satisfy ^1.9.0");
if (!satisfiesRange("1.9.0", "^1.2.0") || satisfiesRange("2.0.0", "^1.2.0")) fail("satisfiesRange sanity");

console.log("PASS: prerelease binds below the release; ranges resolve to the highest match");
