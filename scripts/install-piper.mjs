#!/usr/bin/env node
/**
 * Downloads the Piper TTS engine (binary + ru/en voices) into <repo>/piper/.
 * MIT-licensed engine; run once during setup:
 *   npm run tts:install
 * Works on Windows (zip) and Linux (tar.gz). Uses the system `tar` binary
 * (bsdtar on Windows, GNU tar on Linux — both handle zip and tar.gz).
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argDir = process.argv.find((a) => a.startsWith("--dir="));
const PIPER_DIR = argDir ? argDir.slice("--dir=".length) : path.join(REPO_ROOT, "piper");

const PIPER_RELEASE = "2023.11.14-2";
const BASE = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}`;
const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

const VOICES = [
  ["ru", "female", "ru_RU-irina-medium"],
  ["ru", "male", "ru_RU-dmitri-medium"],
  ["en", "female", "en_US-hfc_female-medium"],
  ["en", "male", "en_US-ryan-medium"],
];

function platformAsset() {
  if (process.platform === "win32") {
    return { file: "piper_windows_amd64.zip", bin: "piper.exe" };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { file: "piper_linux_x86_64.tar.gz", bin: "piper" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { file: "piper_linux_aarch64.tar.gz", bin: "piper" };
  }
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
}

function sh(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
}

async function download(url, dest) {
  process.stdout.write(`  downloading ${path.basename(dest)}… `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  process.stdout.write(`${(existsSync(dest) ? readFileSync(dest).length / 1e6 : 0).toFixed(1)} MB\n`);
}

async function main() {
  mkdirSync(PIPER_DIR, { recursive: true });
  const asset = platformAsset();
  const binPath = path.join(PIPER_DIR, asset.bin);

  console.log(`Piper → ${PIPER_DIR}`);
  if (existsSync(binPath)) {
    console.log("  binary already present, skipping");
  } else {
    const archive = path.join(PIPER_DIR, `piper-${asset.file}`);
    await download(`${BASE}/${asset.file}`, archive);
    console.log("  extracting…");
    sh("tar", ["-xf", archive, "-C", PIPER_DIR]);
    // Flatten the extracted subfolder.
    const sub = path.join(PIPER_DIR, "piper");
    if (existsSync(sub)) {
      for (const entry of readdirSync(sub)) {
        const from = path.join(sub, entry);
        const to = path.join(PIPER_DIR, entry);
        if (!existsSync(to)) {
          try {
            renameSync(from, to);
          } catch {
            copyFileSync(from, to);
            unlinkSync(from);
          }
        }
      }
      rmSync(sub, { recursive: true, force: true });
    }
    unlinkSync(archive);
  }

  for (const [, , voice] of VOICES) {
    const onnx = path.join(PIPER_DIR, `${voice}.onnx`);
    const cfg = path.join(PIPER_DIR, `${voice}.onnx.json`);
    if (existsSync(onnx) && existsSync(cfg)) {
      console.log(`  ${voice}: present`);
      continue;
    }
    const lang = voice.slice(0, 2);
    const langFolder = voice.slice(0, 5); // ru_RU / en_US (lowercase on HF)
    const voiceName = voice.replace(/^(ru_RU|en_US)-/, "").replace(/-medium$/, ""); // irina/amy/…
    const voicePath = `${lang}/${langFolder}/${voiceName}/medium/${voice}`;
    await download(`${HF}/${voicePath}.onnx`, onnx);
    await download(`${HF}/${voicePath}.onnx.json`, cfg);
  }

  // Remove voices that are no longer in the list (e.g. after an upgrade).
  const wanted = new Set(VOICES.map(([, , v]) => v));
  for (const entry of readdirSync(PIPER_DIR)) {
    if (/^[a-z]{2}_[A-Z]{2}-.+-medium\.onnx$/.test(entry)) {
      const base = entry.replace(/\.onnx$/, "");
      if (!wanted.has(base)) {
        console.log(`  removing stale voice ${base}`);
        rmSync(path.join(PIPER_DIR, entry), { force: true });
        rmSync(path.join(PIPER_DIR, `${base}.onnx.json`), { force: true });
      }
    }
  }

  // Smoke test: generate a tiny WAV and check the RIFF header.
  console.log("  smoke test…");
  const probe = path.join(PIPER_DIR, "__probe__.wav");
  const test = spawnSync(
    binPath,
    ["--model", path.join(PIPER_DIR, VOICES[0][2] + ".onnx"), "--output_file", probe],
    { input: "Проверка голоса.\n", encoding: "utf8" },
  );
  const ok = test.status === 0 && existsSync(probe) && readFileSync(probe).subarray(0, 4).toString() === "RIFF";
  rmSync(probe, { force: true });
  if (!ok) throw new Error(`Smoke test failed: ${test.stderr?.slice(0, 300) ?? test.status}`);
  console.log("\nPiper TTS installed. Restart the server — read-aloud will use it automatically.");
}

main().catch((err) => {
  console.error(`\ninstall failed: ${err.message}`);
  process.exit(1);
});
