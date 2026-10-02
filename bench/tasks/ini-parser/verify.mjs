import { readFileSync } from "node:fs";
import { parseIni } from "./lib/ini.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const settings = parseIni(readFileSync("deploy.ini", "utf8"));
if (settings["core.name"] !== "demo") fail("core section broken: " + JSON.stringify(settings["core.name"]));
if (settings["db.host"] !== "localhost" || settings["db.port"] !== "5432") fail("db section broken: " + JSON.stringify(settings));
if (settings["db.url"] !== "postgres://u:p@h/db?ssl=true&app=svc") fail("value with '=' truncated: " + JSON.stringify(settings["db.url"]));
if (settings["auth.token"] !== "abc=def") fail("token with '=' truncated: " + JSON.stringify(settings["auth.token"]));
if (settings["auth.retries"] !== "3") fail("plain value in the same section broken");

const crlf = parseIni("a = 1\r\n[sec]\r\nb = 2\r\n");
if (crlf["core.a"] !== "1" || crlf["sec.b"] !== "2") fail("CRLF files broken");

const inline = parseIni("  # note\n\t; also note\n   key   =   spaced value  \n");
if (inline["core.key"] !== "spaced value") fail("trimming broken: " + JSON.stringify(inline));

let threw = false;
try { parseIni("justtext"); } catch { threw = true; }
if (!threw) fail("a line without '=' must throw");

console.log("PASS: sections, comments and '='-carrying values all parse");
