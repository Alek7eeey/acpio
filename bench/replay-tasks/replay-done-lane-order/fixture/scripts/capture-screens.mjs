/** Capture all documentation screenshots (sequential, low memory). */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONE = path.join(ROOT, "scripts", "capture-one.mjs");

const SHOTS = [
  ["chat-dark-en.webp", "en", "dark", "chat"],
  ["chat-light-en.webp", "en", "light", "chat"],
  ["chat-slash-en.webp", "en", "dark", "slash"],
  ["chat-search-en.webp", "en", "dark", "search"],
  ["chat-split-en.webp", "en", "dark", "split"],
  ["settings-en.webp", "en", "light", "settings"],
  ["settings-agents-en.webp", "en", "light", "settings-agents"],
  ["settings-remote-en.webp", "en", "light", "remote"],
  ["mobile-chat-en.webp", "en", "dark", "mobile"],
  ["chat-dark.webp", "ru", "dark", "chat"],
  ["chat-light.webp", "ru", "light", "chat"],
  ["chat-slash.webp", "ru", "dark", "slash"],
  ["chat-search.webp", "ru", "dark", "search"],
  ["chat-split.webp", "ru", "dark", "split"],
  ["settings.webp", "ru", "light", "settings"],
  ["settings-agents.webp", "ru", "light", "settings-agents"],
  ["settings-remote.webp", "ru", "light", "remote"],
  ["mobile-chat.webp", "ru", "dark", "mobile"],
];

function runOne(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ONE, ...args], { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} failed`))));
  });
}

async function main() {
  console.log("Capturing →", path.join(ROOT, "docs", "screens"));
  for (const shot of SHOTS) {
    await runOne(shot);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
