import { validateConfig } from "./lib/validate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const spec = [
  { path: "port", type: "number", required: true, default: 8080 },
  { path: "db.host", type: "string", required: true },
  { path: "db.pool", type: "number", default: 5 },
  { path: "log.level", type: "string", enum: ["debug", "info", "warn", "error"], default: "info" },
];

if (!eq(validateConfig(spec, {}), ["db.host: required"])) fail("empty config: only db.host (no default) may be required: " + JSON.stringify(validateConfig(spec, {})));
if (!eq(validateConfig(spec, { db: { host: "db1" } }), [])) fail("partial config with defaults must validate");
if (!eq(validateConfig(spec, { port: "8080", db: { host: "db1" } }), ["port: expected number, got string"])) fail("type error must be reported with the dot path");
if (!eq(validateConfig(spec, { db: { host: "db1", pool: "x" } }), ["db.pool: expected number, got string"])) fail("nested type error");
if (!eq(validateConfig(spec, { db: { host: "db1" }, log: { level: "verbose" } }), ["log.level: must be one of debug | info | warn | error"])) fail("enum violation");
if (!eq(validateConfig(spec, { port: 1 }), ["db.host: required"])) fail("missing required without default");

const config = { db: { host: "db1" } };
validateConfig(spec, config);
if (!eq(config, { db: { host: "db1" } })) fail("validateConfig must not mutate its input");

const noDefaults = [{ path: "a.b", required: true }, { path: "x", type: "boolean" }];
if (!eq(validateConfig(noDefaults, { x: "yes" }), ["a.b: required", "x: expected boolean, got string"])) {
  fail("multiple errors expected: " + JSON.stringify(validateConfig(noDefaults, { x: "yes" })));
}

console.log("PASS: defaults apply before checks; errors use dot paths");
