import { encodeCsv } from "./lib/csvw.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  [[["a", "b", "c"]], "a,b,c"],
  [[["x,y"]], '"x,y"'],
  [[['say "hi" now']], '"say ""hi"" now"'],
  [[['a "b" and "c"']], '"a ""b"" and ""c"""'],
  [[["line1\nline2"]], '"line1\nline2"'],
  [[["cr\rhere"]], '"cr\rhere"'],
  [[[null, "", 42, true]], ",,42,true"],
  [[["a"], ["b"]], "a\r\nb"],
  [[["name", "note"], ["ada", 'wrote "code", daily']], "name,note\r\nada,\"wrote \"\"code\"\", daily\""],
  [[["a", "", "c"]], "a,,c"],
  [[[]], ""],
];
for (const [rows, expected] of cases) {
  const got = encodeCsv(rows);
  if (got !== expected) fail(JSON.stringify(rows) + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
}

console.log("PASS: every quote inside a quoted field is doubled");
