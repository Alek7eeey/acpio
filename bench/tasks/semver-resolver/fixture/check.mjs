import { compareVersions } from "./lib/semver.mjs";
import { resolveRange } from "./lib/resolve.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const releaseVsPrerelease = compareVersions("1.0.0", "1.0.0-rc.1");
if (releaseVsPrerelease <= 0) fail("a release must sort ABOVE its prerelease, got " + releaseVsPrerelease);
if (resolveRange(">=1.9.0-beta.1", ["1.9.0-beta.2", "1.9.0"]) !== "1.9.0") {
  fail("even a prerelease-naming range must prefer the release, got " + resolveRange(">=1.9.0-beta.1", ["1.9.0-beta.2", "1.9.0"]));
}

console.log("PASS: prerelease binds below the release");
