import { createRouter } from "./lib/router.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const r = createRouter();
r.add("/users/list", () => "list");
r.add("/users/:id", (ctx) => "id:" + ctx.params.id);
r.add("/health", () => "health");

let m = r.match("/users/list");
if (!m || Object.keys(m.params).length !== 0 || typeof m.handler !== "function") fail("literal route must match with empty params");
m = r.match("/users/list-all");
if (!m || m.params.id !== "list-all") fail("/users/list-all must hit /users/:id, not the /users/list literal");
m = r.match("/users-list");
if (m) fail("prefix-only match dispatched: /users-list matched");
m = r.match("/users/42");
if (!m || m.params.id !== "42") fail("param route broken: " + JSON.stringify(m));
m = r.match("/users/42/posts");
if (m) fail("param must not eat extra segments");
m = r.match("/health");
if (!m || Object.keys(m.params).length !== 0) fail("health route lost");
if (r.match("/healthz")) fail("/healthz must not hit /health");
if (r.match("/nope") !== null) fail("unknown path must not match");
if (r.match("/users") !== null) fail("shorter path must not match");

console.log("PASS: literal segments match exactly, params capture one segment");
