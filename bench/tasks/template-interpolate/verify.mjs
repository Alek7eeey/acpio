import { render } from "./lib/interp.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (render("Hi {{name}}!", { name: "Ada" }) !== "Hi Ada!") fail("single placeholder broken");
let out;
try {
  out = render("Hi {{first}} {{last}}!", { first: "Grace", last: "Hopper" });
} catch (err) {
  fail("two placeholders on a line must both resolve, threw: " + err.message);
}
if (out !== "Hi Grace Hopper!") fail("two placeholders broken: " + JSON.stringify(out));
if (render("{{a}} and {{a}}", { a: "x" }) !== "x and x") fail("a repeated placeholder must resolve twice");
if (render("{{user.name}} from {{user.city}}", { user: { name: "Bo", city: "Oslo" } }) !== "Bo from Oslo") fail("dot paths broken");
if (render("n={{count}} ok={{ok}}", { count: 0, ok: false }) !== "n=0 ok=false") fail("numbers and false must render");
if (render("{{tag}}", { tag: "" }) !== "") fail("empty-string values must render as empty");
if (render("no placeholders here", {}) !== "no placeholders here") fail("plain text broken");
if (render("code: {{a_b.c1}}", { a_b: { c1: 7 } }) !== "code: 7") fail("underscores and digits in paths broken");
if (render("{{ spaced }}", { spaced: 1 }) !== "1") fail("inner whitespace must be tolerated");

let threw = false;
try { render("{{missing.key}}", { missing: {} }); } catch (err) { threw = /missing\.key/.test(err.message); }
if (!threw) fail("a missing key must throw naming the key");
threw = false;
try { render("{{nope}}", {}); } catch { threw = true; }
if (!threw) fail("an unknown key must throw");
threw = false;
try { render("x", null); } catch { threw = true; }
if (!threw) fail("scope must be an object");
if (render("{{a b}}", { a: 1 }) !== "{{a b}}") fail("braces that name no valid path must stay literal");

console.log("PASS: each {{ }} pair resolves on its own");
