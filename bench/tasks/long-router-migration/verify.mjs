// Hidden verifier for long-router-migration.
// lib/ is frozen shared infrastructure (hash-checked); app/server.mjs must
// keep its handle(req) contract; every MIGRATION.md behavior row is replayed
// here; app/ must no longer reference lib/legacy.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const LIB_HASHES = {
  "lib/tiny-http.mjs": "b34f4751a870b9a506a5a3315adf5a7b2817a3f7d66d8a0627536851266bc633",
  "lib/legacy/router.mjs": "2a04389fdf8db64e4c7cec4eb553a4c84a773984ea37f558420e3d0131e0a55e",
};
for (const [file, expected] of Object.entries(LIB_HASHES)) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) fail(`${file} was modified — lib/ is shared infrastructure, migrate app/ instead`);
}

let legacyImports = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/from\s+["'][^"']*lib\/legacy/.test(readFileSync(p, "utf8"))) legacyImports.push(p);
  }
};
walk("app");
if (legacyImports.length) fail(`app/ still imports the legacy router: ${legacyImports.join(", ")}`);

const { handle } = await import("./app/server.mjs");
if (typeof handle !== "function") fail("app/server.mjs no longer exports handle(req)");

let cases = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a?.slice(0, 300)}, want ${b?.slice(0, 300)}`);
  cases += 1;
};
const get = (url, headers = {}) => handle({ method: "GET", url, headers });
const post = (url, body, headers = {}) => handle({ method: "POST", url, body, headers });
const ADMIN = { "x-admin-token": "secret42" };

eq(get("/health"), { status: 200, body: { status: "ok" } }, "GET /health");
eq(get("/metrics"), { status: 200, body: { requests: 0 } }, "GET /metrics");
eq(post("/echo", "hi"), { status: 200, body: { echo: "hi" } }, "POST /echo");
eq(get("/users"), { status: 200, body: { users: [{ id: "u1", name: "alice" }, { id: "u2", name: "bob" }, { id: "u3", name: "carol" }] } }, "GET /users");
eq(get("/users?limit=2"), { status: 200, body: { users: [{ id: "u1", name: "alice" }, { id: "u2", name: "bob" }] } }, "GET /users?limit=2");
eq(get("/users?limit=0"), { status: 400, body: { error: "bad_limit" } }, "GET /users?limit=0");
eq(get("/users?limit=abc"), { status: 400, body: { error: "bad_limit" } }, "GET /users?limit=abc");
eq(get("/users/u2"), { status: 200, body: { user: { id: "u2", name: "bob" } } }, "GET /users/u2");
eq(get("/users/zz"), { status: 404, body: { error: "user_not_found" } }, "GET /users/zz");
eq(get("/users/"), { status: 404, body: { error: "not_found" } }, "GET /users/ (empty segment)");
eq(get("/orders"), { status: 200, body: { orders: [{ id: "o1", userId: "u1", total: 250 }, { id: "o2", userId: "u1", total: 120 }, { id: "o3", userId: "u2", total: 80 }] } }, "GET /orders");
eq(get("/orders?userId=u1"), { status: 200, body: { orders: [{ id: "o1", userId: "u1", total: 250 }, { id: "o2", userId: "u1", total: 120 }] } }, "GET /orders?userId=u1");
eq(get("/orders?userId=zz"), { status: 200, body: { orders: [] } }, "GET /orders?userId=zz");
eq(get("/admin/stats", ADMIN), { status: 200, body: { users: 3, orders: 3 } }, "GET /admin/stats with token");
eq(get("/admin/stats"), { status: 401, body: { error: "unauthorized" } }, "GET /admin/stats without token");
eq(get("/admin/stats", { "x-admin-token": "nope" }), { status: 401, body: { error: "unauthorized" } }, "GET /admin/stats wrong token");
eq(post("/admin/message", JSON.stringify({ text: "hi" }), ADMIN), { status: 200, body: { queued: "hi" } }, "POST /admin/message ok");
eq(post("/admin/message", "{oops", ADMIN), { status: 400, body: { error: "bad_json" } }, "POST /admin/message bad json");
eq(get("/nope"), { status: 404, body: { error: "not_found" } }, "GET /nope");
eq(handle({ method: "DELETE", url: "/health" }), { status: 404, body: { error: "not_found" } }, "DELETE /health");

console.log(`PASS: migration holds the full behavior contract (${cases} cases), lib/ frozen, no legacy imports`);
