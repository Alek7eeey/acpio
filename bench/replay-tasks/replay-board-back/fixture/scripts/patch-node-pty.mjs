/**
 * node-pty@1.1.0 (Windows/ConPTY) bug workarounds.
 *
 * 1. lib/conpty_console_list_agent.js — AttachConsole() throws when the ConPTY
 *    console is already gone (shell exited, or the pty was killed right after this
 *    agent was forked). The crash spams stderr with a stack trace and leaves the
 *    caller waiting for its 5s timeout.
 *
 * 2. lib/windowsPtyAgent.js kill() — forks the console-list agent and then kills the
 *    pty immediately. The agent needs a full Node startup to call AttachConsole, so
 *    the console is always destroyed first: the console process list is never
 *    obtained and children of the shell (background jobs) survive the kill.
 *    Fix: wait for the agent's answer, kill the console process tree, then kill the pty.
 *
 * Idempotent: re-running is a no-op. Prints a warning (without failing the install)
 * when node-pty changes underneath us and the patterns no longer match.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(root, "node_modules", "node-pty", "lib");
const MARKER = "acpio-patch:";

const patches = [
  {
    file: path.join(libDir, "conpty_console_list_agent.js"),
    find: `var shellPid = parseInt(process.argv[2], 10);
var consoleProcessList = getConsoleProcessList(shellPid);`,
    replace: `var shellPid = parseInt(process.argv[2], 10);
var consoleProcessList;
try {
    // ${MARKER} AttachConsole fails when the ConPTY console is already gone.
    consoleProcessList = getConsoleProcessList(shellPid);
}
catch (e) {
    consoleProcessList = [shellPid];
}`,
  },
  {
    file: path.join(libDir, "windowsPtyAgent.js"),
    find: `                this._getConsoleProcessList().then(function (consoleProcessList) {
                    consoleProcessList.forEach(function (pid) {
                        try {
                            process.kill(pid);
                        }
                        catch (e) {
                            // Ignore if process cannot be found (kill ESRCH error)
                        }
                    });
                });
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._conoutSocketWorker.dispose();`,
    replace: `                // ${MARKER} enumerate the console process tree before destroying it,
                // otherwise AttachConsole in the agent always fails and shell children leak.
                this._getConsoleProcessList().catch(function () { return []; }).then(function (consoleProcessList) {
                    consoleProcessList.forEach(function (pid) {
                        if (pid === process.pid) {
                            return;
                        }
                        try {
                            process.kill(pid);
                        }
                        catch (e) {
                            // Ignore if process cannot be found (kill ESRCH error)
                        }
                    });
                    _this._ptyNative.kill(_this._pty, _this._useConptyDll);
                    _this._conoutSocketWorker.dispose();
                });`,
  },
];

let changed = false;
for (const { file, find, replace } of patches) {
  const name = path.relative(root, file);
  if (!fs.existsSync(file)) {
    console.warn(`patch-node-pty: ${name} not found (node-pty not installed?) — skipped`);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(MARKER)) continue;
  if (!src.includes(find)) {
    console.warn(
      `patch-node-pty: pattern not found in ${name} — node-pty version changed, ` +
        `the AttachConsole/orphan-process bug may be back. Review lib/ and update scripts/patch-node-pty.mjs.`,
    );
    continue;
  }
  fs.writeFileSync(file, src.replace(find, replace));
  console.log(`patch-node-pty: patched ${name}`);
  changed = true;
}
if (!changed) console.log("patch-node-pty: node-pty already patched (or nothing to do)");
