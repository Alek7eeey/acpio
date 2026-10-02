import { evaluate } from "./lib/expr.mjs";
import { tokenize } from "./lib/lexer.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const almost = (a, b) => Math.abs(a - b) < 1e-9;

if (evaluate("2+3*4") !== 14) fail("precedence broken: " + evaluate("2+3*4"));
if (evaluate("2*3+4*5") !== 26) fail("mixed terms broken: " + evaluate("2*3+4*5"));
if (evaluate("10-4/2") !== 8) fail("division precedence broken: " + evaluate("10-4/2"));
if (evaluate("2-3-4") !== -5) fail("left associativity broken: " + evaluate("2-3-4"));
if (evaluate("100/5/2") !== 10) fail("left associativity for / broken");
if (evaluate("(2+3)*4") !== 20) fail("parens broken");
if (evaluate("((1+2)*(3+4))") !== 21) fail("nested parens broken");
if (evaluate("-3+5") !== 2) fail("unary minus broken");
if (evaluate("2*-3") !== -6) fail("unary minus after * broken");
if (evaluate("-(2+3)") !== -5) fail("negated group broken");
if (!almost(evaluate("1.5*2"), 3)) fail("decimals broken");
if (evaluate("  7  *  3 ") !== 21) fail("whitespace broken");
if (evaluate("price * qty - discount", { price: 10, qty: 4, discount: 5 }) !== 35) fail("variables broken");

let threw = false;
try { evaluate("foo+1"); } catch (err) { threw = /unknown variable: foo/.test(err.message); }
if (!threw) fail("unknown variables must throw naming the variable");
threw = false;
try { evaluate("1/0"); } catch { threw = true; }
if (!threw) fail("division by zero must throw");
threw = false;
try { evaluate("2 3"); } catch { threw = true; }
if (!threw) fail("trailing input must throw");
threw = false;
try { evaluate("(2+3"); } catch { threw = true; }
if (!threw) fail("unbalanced parens must throw");
threw = false;
try { evaluate(""); } catch { threw = true; }
if (!threw) fail("an empty expression must throw");
threw = false;
try { tokenize("2 @ 3"); } catch { threw = true; }
if (!threw) fail("lexing a stray character must throw");

console.log("PASS: the grammar layers keep their own operators");
