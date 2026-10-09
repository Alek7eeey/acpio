// Hidden verifier: parses config.json from scratch and compares it against the
// exact required content — the two corrected leaves, the one added key, and
// every other pre-existing leaf unchanged.

import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync("./config.json", "utf8");
} catch (err) {
  fail(`config.json missing: ${String(err.message).split("\n")[0]}`);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (err) {
  fail(`config.json is not valid JSON: ${String(err.message).split("\n")[0]}`);
}

const expected = {
  app: {
    name: "bench-runner",
    env: "production",
    server: {
      host: "127.0.0.1",
      port: 9000,
      timeoutMs: 5000,
      gzip: true,
    },
  },
  logging: {
    level: "info",
    targets: {
      file: {
        path: "logs/bench.log",
        rotate: true,
        maxSizeMb: 25,
      },
      console: {
        enabled: true,
      },
    },
  },
  features: {
    betaDashboard: false,
    cache: {
      ttlSeconds: 60,
    },
  },
};

function firstDiff(actual, wanted, path) {
  if (actual === wanted) return null;
  const aObj = actual !== null && typeof actual === "object";
  const wObj = wanted !== null && typeof wanted === "object";
  if (!aObj || !wObj) return { path, actual, wanted };
  if (Array.isArray(actual) !== Array.isArray(wanted)) return { path, actual, wanted };
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(wanted)])];
  for (const key of keys) {
    const here = path ? `${path}.${key}` : key;
    if (!(key in actual)) return { path: here, actual: "(missing)", wanted: wanted[key] };
    if (!(key in wanted)) return { path: here, actual: actual[key], wanted: "(nothing extra allowed)" };
    const diff = firstDiff(actual[key], wanted[key], here);
    if (diff) return diff;
  }
  return null;
}

const diff = firstDiff(parsed, expected, "config.json");
if (diff) {
  fail(
    `${diff.path} is ${JSON.stringify(diff.actual)}, expected ${JSON.stringify(diff.wanted)}` +
      " (the whole file must otherwise match)",
  );
}
console.log("PASS: config.json has both corrections, the new key, and nothing else changed");
