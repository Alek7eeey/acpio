import { loadConfig } from "./lib/config.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cfg = loadConfig({
  file: { port: 8080, db: { host: "local", pool: 2 }, name: "svc" },
  env: { PORT: "9000", DB__HOST: "remote", DB__POOL: "8", NEW__FLAG: "true" },
});
if (cfg.port !== "9000") fail("env must override file for port, got " + JSON.stringify(cfg.port));
if (cfg.db.host !== "remote") fail("env must override file for db.host, got " + JSON.stringify(cfg.db));
if (cfg.db.pool !== "8") fail("env must set nested db.pool, got " + JSON.stringify(cfg.db));
if (cfg.db.pool === 8) fail("env values arrive as strings, no coercion expected");
if (cfg.name !== "svc") fail("file-only key lost: " + JSON.stringify(cfg));
if (cfg.new.flag !== "true") fail("new nested env key missing: " + JSON.stringify(cfg.new));

const onlyFile = loadConfig({ file: { a: 1 } });
if (onlyFile.a !== 1) fail("file-only config broken");
const onlyEnv = loadConfig({ env: { A__B: "x" } });
if (onlyEnv.a.b !== "x") fail("env-only config broken");

console.log("PASS: precedence is defaults < file < env, __ maps nesting");
