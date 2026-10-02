import { readFileSync } from "node:fs";
import { parseIni } from "./lib/ini.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const settings = parseIni(readFileSync("deploy.ini", "utf8"));
if (settings["auth.token"] !== "abc=def") fail("token truncated: " + JSON.stringify(settings["auth.token"]));
if (settings["db.url"] !== "postgres://u:p@h/db?ssl=true&app=svc") fail("url truncated: " + JSON.stringify(settings["db.url"]));

console.log("PASS: values survive every '=' after the first");
