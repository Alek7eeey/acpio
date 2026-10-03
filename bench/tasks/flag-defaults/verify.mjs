import { flagStore } from "./lib/store.mjs";
import { evaluate } from "./lib/evaluate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rollout = (ctx) => (ctx.user.id % 4 === 0 ? true : false); // every fourth user
const store = flagStore([
  { id: "static-on", default: true },
  { id: "static-off", default: false },
  { id: "beta", default: rollout },
]);

if (evaluate(store, "static-on", { user: { id: 1 } }) !== true) fail("plain true default");
if (evaluate(store, "static-off", { user: { id: 1 } }) !== false) fail("plain false default");
if (evaluate(store, "beta", { user: { id: 4 } }) !== true) fail("rollout admits user 4");
if (evaluate(store, "beta", { user: { id: 5 } }) !== false) fail("rollout keeps user 5 out: got " + evaluate(store, "beta", { user: { id: 5 } }));
if (evaluate(store, "beta", { user: { id: 5, beta: true } }) !== true) fail("user override beats the rollout");
if (evaluate(store, "static-off", { user: { id: 1 }, env: { "static-off": true } }) !== true) fail("env beats the default");
if (evaluate(store, "nope", { user: { id: 1 } }) !== false) fail("unknown flag is false");

console.log("PASS: rollout rules are called with the context, overrides win");
