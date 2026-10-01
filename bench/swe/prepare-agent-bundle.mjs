// Builds the Linux bundle the SWE-bench runner injects into every swebench
// eval container: the compiled acpio server, the workspace packages, production
// node_modules with native modules compiled FOR LINUX, and a node runtime.
//
//   node bench/swe/prepare-agent-bundle.mjs            # build + assemble + docker prep
//   node bench/swe/prepare-agent-bundle.mjs --no-build # reuse the current dist/
//
// Output: bench/.cache/swe-agent-bundle.tar.gz — docker cp'd into a container
// and untarred at /, it gives /bundle/apps/server/dist/index.js plus
// /bundle/node/bin/node. The npm install step runs inside a node:22-bookworm
// container because better-sqlite3 / node-pty are native and must match the
// containers' linux/glibc, not the Windows host.
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = path.join(REPO, "bench", ".cache");
const STAGING = path.join(CACHE, "swe-bundle");
const TARBALL = path.join(CACHE, "swe-agent-bundle.tar.gz");
const NODE_VERSION = process.env.SWE_NODE_VERSION || "22.20.0";
const NODE_IMAGE = `node:${NODE_VERSION.split(".").slice(0, 2).join(".")}-bookworm`;
const PREP_CONTAINER = "swe-agent-prep";
// The server resolves @acpio/* and registry deps through these; adapter-builtin
// must be listed even though scripts/package-dist.mjs omits it (latent).
const PACKAGES = ["shared", "i18n", "adapter-builtin", "adapter-cursor", "adapter-omp"];
const BUILD_CHAIN = [
  "@acpio/shared",
  "@acpio/i18n",
  "@acpio/adapter-cursor",
  "@acpio/adapter-omp",
  "@acpio/adapter-builtin",
  "@acpio/server",
];

const noBuild = process.argv.includes("--no-build");
const mb = (p) => (statSync(p).size / 1e6).toFixed(1);

/**
 * The CLI agents ride in the same bundle so pi/omp can run inside the SWE
 * containers exactly like the builtin agent does. Versions are pinned to what
 * this machine actually runs — the bundle tests those builds, not npm latest.
 */
function hostAgentVersions() {
  const read = (p) => JSON.parse(readFileSync(p, "utf8")).version;
  const piPkg = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const ompPkg = path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json");
  for (const p of [piPkg, ompPkg]) {
    if (!existsSync(p)) throw new Error(`CLI agent not found: ${p} — install pi/omp or drop them from the bundle`);
  }
  // Precedence: SWE_PI_VERSION / SWE_OMP_VERSION env, then the versions pinned
  // in swe-provider.json (the zen gateway needs omp >= 18.4.5 for its native
  // x-opencode-session), then whatever the host runs.
  const pinned = (() => {
    try {
      return JSON.parse(readFileSync(path.join(CACHE, "swe-provider.json"), "utf8"));
    } catch {
      return {};
    }
  })();
  return {
    pi: process.env.SWE_PI_VERSION || pinned.piVersion || read(piPkg),
    omp: process.env.SWE_OMP_VERSION || pinned.ompVersion || read(ompPkg),
  };
}

function hostBunVersion() {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error("bun not found on PATH — omp needs it");
  return r.stdout.trim();
}

function sh(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: REPO, stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit", ...opts });
}

function docker(args, { timeoutMs = 600_000 } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} -> ${r.status}\n${(r.stderr || "").slice(-800)}`);
  return (r.stdout || "").trim();
}

function buildWorkspaces() {
  sh("node scripts/generate-version.mjs", { quiet: true });
  for (const ws of BUILD_CHAIN) sh(`npm run build -w ${ws}`);
}

/** Mirror scripts/package-dist.mjs's layout (fixed "../../.." root hops). */
function assembleStaging() {
  rmSync(STAGING, { recursive: true, force: true });
  cpSync(path.join(REPO, "apps", "server", "dist"), path.join(STAGING, "apps", "server", "dist"), { recursive: true });
  const webDist = path.join(REPO, "apps", "web", "dist");
  if (existsSync(webDist)) cpSync(webDist, path.join(STAGING, "apps", "web", "dist"), { recursive: true });
  else console.log("⚠️ apps/web/dist missing — the container server will run API-only (fine for SWE)");
  for (const name of PACKAGES) {
    const src = path.join(REPO, "packages", name);
    cpSync(path.join(src, "dist"), path.join(STAGING, "packages", name, "dist"), { recursive: true });
    cpSync(path.join(src, "package.json"), path.join(STAGING, "packages", name, "package.json"));
  }
  const serverPkg = JSON.parse(readFileSync(path.join(REPO, "apps", "server", "package.json"), "utf8"));
  const dependencies = {};
  for (const [name, ver] of Object.entries(serverPkg.dependencies)) {
    if (name.startsWith("@acpio/")) continue;
    dependencies[name] = ver;
  }
  for (const name of PACKAGES) dependencies[`@acpio/${name}`] = `file:packages/${name}`;
  writeFileSync(
    path.join(STAGING, "package.json"),
    JSON.stringify(
      {
        name: "acpio",
        version: serverPkg.version,
        private: true,
        type: "module",
        engines: { node: ">=20" },
        scripts: { start: "node apps/server/dist/index.js" },
        dependencies,
      },
      null, 2,
    ) + "\n",
  );
}

async function downloadNode() {
  const dest = path.join(CACHE, `node-v${NODE_VERSION}-linux-x64.tar.xz`);
  if (existsSync(dest) && statSync(dest).size > 20e6) return dest;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`node download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

function prepInDocker(nodeTarball, versions, bunVersion) {
  const have = spawnSync("docker", ["image", "inspect", NODE_IMAGE], { encoding: "utf8", windowsHide: true });
  if (have.status !== 0) {
    console.log(`pulling ${NODE_IMAGE}…`);
    docker(["pull", NODE_IMAGE], { timeoutMs: 900_000 });
  }
  console.log(`prep image: ${NODE_IMAGE}`);
  try {
    docker(["rm", "-f", PREP_CONTAINER], { timeoutMs: 30_000 });
  } catch {}
  docker(["run", "-d", "--name", PREP_CONTAINER, NODE_IMAGE, "sleep", "infinity"]);
  try {
    docker(["cp", STAGING, `${PREP_CONTAINER}:/bundle`]);
    docker(["cp", nodeTarball, `${PREP_CONTAINER}:/node.tar.xz`]);
    // Native modules (better-sqlite3, node-pty) must be built for the linux
    // containers SWE-bench runs; node:bookworm ships the toolchain, python3
    // (node-gyp's dependency) is apt-installed only if missing.
    docker(
      [
        "exec", PREP_CONTAINER, "/bin/bash", "-c",
        [
          "set -e",
          "mkdir -p /bundle/node",
          "tar -xJf /node.tar.xz -C /bundle/node --strip-components=1",
          "rm -rf /bundle/node/lib /bundle/node/include /bundle/node/share /bundle/node/bin/npm /bundle/node/bin/npx /bundle/node/bin/corepack",
          "python3 --version 2>/dev/null || { apt-get update -qq && apt-get install -y -qq --no-install-recommends python3; }",
          "cd /bundle",
          "npm install --omit=dev --no-audit --no-fund --loglevel=error",
          // The CLI agents (pi under the bundled node, omp under a bundled bun)
          // installed for linux at the exact versions the host runs.
          `npm install -g --loglevel=error bun@${bunVersion}`,
          `mkdir -p /bundle/agents/pi && cd /bundle/agents/pi && echo '{"name":"pi-agent","private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@${versions.pi}`,
          `mkdir -p /bundle/agents/omp && cd /bundle/agents/omp && echo '{"name":"omp-agent","private":true}' > package.json && bun add @oh-my-pi/pi-coding-agent@${versions.omp}`,
          'cp "$(command -v bun)" /bundle/bun',
          "cd /bundle",
          "tar -czf /bundle.tgz -C / bundle",
        ].join(" && "),
      ],
      { timeoutMs: 1_800_000 },
    );
    rmSync(TARBALL, { force: true });
    docker(["cp", `${PREP_CONTAINER}:/bundle.tgz`, TARBALL]);
  } finally {
    try {
      docker(["rm", "-f", PREP_CONTAINER], { timeoutMs: 60_000 });
    } catch {}
  }
}

await (async () => {
  mkdirSync(CACHE, { recursive: true });
  if (!noBuild) buildWorkspaces();
  if (!existsSync(path.join(REPO, "apps", "server", "dist", "index.js"))) {
    throw new Error("apps/server/dist/index.js missing — run without --no-build");
  }
  console.log("assembling staging bundle…");
  assembleStaging();
  const nodeTarball = await downloadNode();
  const versions = hostAgentVersions();
  const bunVersion = hostBunVersion();
  console.log(`agents in bundle: pi ${versions.pi} (node), omp ${versions.omp} (bun ${bunVersion})`);
  console.log(`preparing linux deps in docker (${NODE_IMAGE})…`);
  prepInDocker(nodeTarball, versions, bunVersion);
  let git = "";
  try {
    git = execSync("git rev-parse --short HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {}
  writeFileSync(
    path.join(CACHE, "swe-agent-bundle.json"),
    JSON.stringify({ git, node: NODE_VERSION, pi: versions.pi, omp: versions.omp, bun: bunVersion, builtAt: new Date().toISOString(), bytes: statSync(TARBALL).size }, null, 2) + "\n",
  );
  console.log(`\n${TARBALL} (${mb(TARBALL)} MB) — bundle git ${git}, node v${NODE_VERSION}, pi ${versions.pi}, omp ${versions.omp}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
