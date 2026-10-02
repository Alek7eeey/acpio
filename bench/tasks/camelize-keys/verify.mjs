import { camelize } from "./lib/camelize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const payload = { user_id: 7, profile: { display_name: "Ada", contact: { home_town: "Lyn" } }, tags: [{ tag_id: 3 }] };
const mapped = camelize(payload);
if (!eq(mapped, { userId: 7, profile: { displayName: "Ada", contact: { homeTown: "Lyn" } }, tags: [{ tagId: 3 }] })) {
  fail("deep conversion broken: " + JSON.stringify(mapped));
}
if (!eq(camelize([{ first_name: "a" }, { first_name: "b" }]), [{ firstName: "a" }, { firstName: "b" }])) fail("arrays of objects broken");
if (!eq(camelize({ "created-at": "x", sha256_hash: "y" }), { createdAt: "x", sha256Hash: "y" })) fail("kebab and digit keys broken");
if (camelize("plain") !== "plain" || camelize(5) !== 5 || camelize(null) !== null) fail("scalars must pass through");
if (camelize({ alreadyCamel: 1 }).alreadyCamel !== 1) fail("camel keys must stay");
if (!eq(payload, { user_id: 7, profile: { display_name: "Ada", contact: { home_town: "Lyn" } }, tags: [{ tag_id: 3 }] })) fail("input was mutated");
if (!eq(camelize({}), {}) || !eq(camelize([]), [])) fail("empty containers broken");

console.log("PASS: keys camelize recursively, input stays intact");
