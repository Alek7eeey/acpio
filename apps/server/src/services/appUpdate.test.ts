// The updater against a stub registry: which number counts as a new version,
// how often it is asked, and what the popup sees while npm works — never the
// real npm and never the real registry.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bundleInstall,
  createAppUpdater,
  gitInstall,
  installCommand,
  installPrefix,
  isNpmPackageManifest,
  restartCommand,
  restartServer,
  restartScript,
  updateKind,
  type InstallOutcome,
} from "./appUpdate.js";

let server: Server;
let base = "";
/** What the stub answers with on the next request; null = an unreachable registry. */
let registryAnswer: { version?: unknown } | null = null;
let registryStatus = 200;
let requests = 0;

/** Bound TCP port of a listening server (fails the test otherwise). */
function portOf(target: Server): number {
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("server is not listening");
  return address.port;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests += 1;
    if (registryStatus !== 200) {
      res.statusCode = registryStatus;
      res.end("nope");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(registryAnswer ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}/acpio/latest`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  registryAnswer = null;
  registryStatus = 200;
  requests = 0;
});

function updater(options: Parameters<typeof createAppUpdater>[0] = {}) {
  return createAppUpdater({
    registryUrl: base,
    current: "0.1.41",
    // These tests are about the registry and an install; which copy of Acpio
    // the test runner happens to sit in is not theirs to read.
    kind: "npm",
    selfUpdate: true,
    readAppVersion: () => null,
    ...options,
  });
}

describe("checking the registry", () => {
  it("calls a higher version on npm an update", async () => {
    registryAnswer = { version: "0.1.42" };
    const state = await updater({}).state();
    expect(state).toMatchObject({
      current: "0.1.41",
      latest: "0.1.42",
      available: true,
      status: "idle",
    });
    expect(state.checkedAt).not.toBeNull();
  });

  it("stays quiet while npm has this same build", async () => {
    registryAnswer = { version: "0.1.41" };
    const state = await updater({}).state();
    expect(state.available).toBe(false);
    expect(state.latest).toBe("0.1.41");
  });

  it("never announces an older version than the one running", async () => {
    registryAnswer = { version: "0.1.40" };
    expect((await updater({}).state()).available).toBe(false);
  });

  it("answers without a version when the registry says nothing usable", async () => {
    registryAnswer = { version: "latest" };
    const state = await updater({}).state();
    expect(state).toMatchObject({ latest: null, available: false });
  });

  it("survives a registry that is down", async () => {
    registryStatus = 503;
    const state = await updater({}).state();
    expect(state).toMatchObject({ latest: null, available: false, status: "idle" });
  });

  it("asks once and answers the next poll from the cache", async () => {
    registryAnswer = { version: "0.1.42" };
    const instance = updater({});
    await instance.state();
    await instance.state();
    await instance.state();
    expect(requests).toBe(1);
  });

  it("retries a failed check sooner than a good one", async () => {
    registryStatus = 503;
    let clock = 0;
    registryAnswer = { version: "0.1.42" };
    const instance = updater({ now: () => clock });
    expect((await instance.state()).available).toBe(false);
    // Still inside the short failure window: the answer stands.
    registryStatus = 200;
    clock += 30_000;
    expect((await instance.state()).available).toBe(false);
    // Past it: the registry is asked again and the version lands.
    clock += 31_000;
    expect((await instance.state()).available).toBe(true);
    expect(requests).toBe(2);
  });
});

describe("which copy this is", () => {
  it("knows the published npm package from a checkout and from the portable bundle", () => {
    expect(
      isNpmPackageManifest({ name: "acpio", version: "0.1.43", bin: { acpio: "bin/acpio.mjs" } }),
    ).toBe(true);
    // A checkout of the sources and the unpacked release bundle are Acpio too,
    // but npm's package is not what they run.
    expect(
      isNpmPackageManifest({
        name: "acpio",
        version: "0.1.0",
        private: true,
        workspaces: ["apps/*"],
      }),
    ).toBe(false);
    expect(isNpmPackageManifest({ name: "acprocess", version: "0.1.0", private: true })).toBe(
      false,
    );
    expect(isNpmPackageManifest(null)).toBe(false);
  });

  it("offers npm's number as news, and no install this copy could not make", async () => {
    registryAnswer = { version: "0.1.42" };
    const ran: string[] = [];
    const instance = updater({
      selfUpdate: false,
      runInstall: async (version) => {
        ran.push(version);
        return { code: 0, output: "" };
      },
    });
    expect(await instance.state()).toMatchObject({
      latest: "0.1.42",
      available: true,
      selfUpdate: false,
    });
    // Whatever the popup asks, npm is not touched: it would install a copy
    // nobody runs and leave this one exactly as it is.
    expect((await instance.install()).status).toBe("idle");
    expect(ran).toEqual([]);
  });

  it("installs into the prefix this copy lives in, not whatever npm calls global", () => {
    const prefix = installPrefix("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\acpio");
    expect(prefix).toBe("C:\\Users\\me\\AppData\\Roaming\\npm");
    // npm's layout on posix keeps global packages one directory deeper.
    expect(installPrefix("/usr/local/lib/node_modules/acpio")).toBe("/usr/local");
    // A copy outside npm's tree has no prefix to install back into.
    expect(installPrefix("/opt/acpio")).toBeNull();
    expect(installCommand("0.1.42", prefix)).toContain(
      '--prefix "C:\\Users\\me\\AppData\\Roaming\\npm"',
    );
    expect(installCommand("0.1.42", null)).toContain("npm install -g acpio@0.1.42");
  });

  it("says so when the install landed on another copy", async () => {
    registryAnswer = { version: "0.1.42" };
    const instance = updater({
      runInstall: async () => ({ code: 0, output: "added 1 package" }),
      // npm was happy, but this copy on disk is still the one that runs.
      readAppVersion: () => "0.1.41",
    });
    await instance.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await instance.state();
    expect(state.status).toBe("error");
    expect(state.message).toContain("0.1.42");
    expect(state.message).toContain("0.1.41");
  });

  it("leaves a downloaded bundle for the restart to put in place", async () => {
    registryAnswer = { version: "0.1.42" };
    const instance = updater({
      kind: "bundle",
      appRoot: "/app/bundle",
      runInstall: async () => ({ code: 0, output: "unpacked" }),
    });
    // The bundle replaces files this process holds open: nothing is swapped
    // until the restart, which is told where the download waits.
    expect(instance.pendingFiles()).toBeNull();
    await instance.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await instance.state()).status).toBe("done");
    expect(instance.pendingFiles()).toBe(path.join("/app/bundle", ".update-0.1.42"));
  });

  it("calls the install done once this copy really is the new version", async () => {
    registryAnswer = { version: "0.1.42" };
    const instance = updater({
      runInstall: async () => ({ code: 0, output: "" }),
      readAppVersion: () => "0.1.42",
    });
    await instance.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await instance.state()).status).toBe("done");
  });
});

describe("the three ways an Acpio is installed", () => {
  it("pulls, installs and builds a checkout, in the checkout itself", async () => {
    const ran: Array<{ command: string; cwd: string }> = [];
    const outcome = await gitInstall("/app/checkout", async (command, cwd) => {
      ran.push({ command, cwd });
      return { code: 0, output: "ok" };
    });
    expect(outcome.code).toBe(0);
    expect(ran.map((step) => step.command)).toEqual([
      "git pull --ff-only",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    expect(ran.every((step) => step.cwd === "/app/checkout")).toBe(true);
  });

  it("stops at the step that failed and keeps its words for the popup", async () => {
    const outcome = await gitInstall("/app/checkout", async (command) => ({
      code: command.startsWith("git") ? 1 : 0,
      output: "error: Your local changes would be overwritten by merge",
    }));
    // A tree with uncommitted work is not something an update may merge over.
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain("git pull --ff-only failed");
    expect(outcome.output).toContain("local changes");
  });

  it("downloads the release zip of the version and unpacks it beside the copy", async () => {
    const asked: string[] = [];
    const unpacked: string[] = [];
    const outcome = await bundleInstall("/app/bundle", "0.1.42", {
      runCommand: async () => ({ code: 0, output: "" }),
      download: async (url) => {
        asked.push(url);
      },
      extract: async (_zip, dir) => {
        unpacked.push(dir);
      },
    });
    expect(outcome.code).toBe(0);
    expect(asked).toEqual([
      "https://github.com/Alek7eeey/acpio/releases/download/v0.1.42/acpio-win-x64.zip",
    ]);
    expect(unpacked).toEqual([path.join("/app/bundle", ".update-0.1.42")]);
  });

  it("reports a bundle that never arrived", async () => {
    const outcome = await bundleInstall("/app/bundle", "0.1.42", {
      runCommand: async () => ({ code: 0, output: "" }),
      download: async () => {
        throw new Error("404 Not Found");
      },
      extract: async () => {},
    });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toContain("404");
  });

  it("knows the three copies apart, and gives up on anything else", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "acpio-copy-"));
    try {
      // npm's package, the way `npm i -g` and `npx` lay it out.
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "acpio", version: "0.1.42", bin: { acpio: "bin/acpio.mjs" } }),
      );
      expect(updateKind(root)).toBe("npm");

      // A checkout of the sources: private, a workspace root, and a git tree.
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "acpio", version: "0.1.0", private: true, workspaces: ["apps/*"] }),
      );
      mkdirSync(path.join(root, ".git"));
      expect(updateKind(root)).toBe("git");

      // The unpacked release bundle: a built server, no git, no npm manifest.
      rmSync(path.join(root, ".git"), { recursive: true, force: true });
      rmSync(path.join(root, "package.json"));
      mkdirSync(path.join(root, "apps", "server", "dist"), { recursive: true });
      writeFileSync(path.join(root, "apps", "server", "dist", "index.js"), "");
      expect(updateKind(root, "win32")).toBe("bundle");
      // The zip is published for Windows alone.
      expect(updateKind(root, "linux")).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installing", () => {
  it("names the packages whose install scripts build the native modules", () => {
    // npm 11.17+ builds nothing for a package it was not told about, and an
    // update that skips better-sqlite3 leaves a build that cannot open its
    // database — the same failure a plain `npm i -g acpio` hits.
    expect(installCommand("0.1.42")).toContain("--allow-scripts=acpio,better-sqlite3,node-pty");
    expect(installCommand("0.1.42")).toContain("npm install -g acpio@0.1.42");
    // Nothing but a parsed version may reach that command line.
    expect(installCommand("0.1.42; rm -rf ~")).toBeNull();
    expect(installCommand("latest")).toBeNull();
  });

  it("runs npm for the version on the registry, and reports done when it exits 0", async () => {
    registryAnswer = { version: "0.1.42" };
    const calls: string[] = [];
    const instance = updater({
      runInstall: async (version) => {
        calls.push(version);
        return { code: 0, output: "added 1 package" };
      },
    });
    const started = await instance.install();
    expect(started.status).toBe("installing");
    expect(calls).toEqual(["0.1.42"]);
    // The install finishes in the background; the next poll sees it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await instance.state()).toMatchObject({ status: "done", latest: "0.1.42" });
  });

  it("keeps npm's last words when the install fails", async () => {
    registryAnswer = { version: "0.1.42" };
    const instance = updater({
      runInstall: async () => ({
        code: 1,
        output: "npm error code EBUSY\nnpm error path acpio/node_modules/node-pty\nnpm error resource busy",
      }),
    });
    await instance.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = await instance.state();
    expect(state.status).toBe("error");
    expect(state.message).toContain("resource busy");
    expect(state.available).toBe(true);
  });

  it("does not run npm when this build is already the newest", async () => {
    registryAnswer = { version: "0.1.41" };
    let ran = 0;
    const instance = updater({
      runInstall: async () => {
        ran += 1;
        return { code: 0, output: "" };
      },
    });
    const state = await instance.install();
    expect(ran).toBe(0);
    expect(state.status).toBe("idle");
  });

  it("treats a second click as the install already running", async () => {
    registryAnswer = { version: "0.1.42" };
    let ran = 0;
    let finish: (outcome: InstallOutcome) => void = () => {};
    const instance = updater({
      runInstall: () =>
        new Promise<InstallOutcome>((resolve) => {
          ran += 1;
          finish = resolve;
        }),
    });
    await instance.install();
    const second = await instance.install();
    expect(ran).toBe(1);
    expect(second.status).toBe("installing");
    finish({ code: 0, output: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await instance.state()).status).toBe("done");
  });
});

describe("restarting", () => {
  it("repeats this process's command line after the port is free", () => {
    const launched: string[] = [];
    const exited: number[] = [];
    const ok = restartServer({
      argv: ["/app/bin/acpio.mjs"],
      execArgv: [],
      delayMs: 10,
      launch: (script) => launched.push(script),
      exit: (code) => exited.push(code),
    });
    expect(ok).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain('["/app/bin/acpio.mjs"]');
    expect(launched[0]).toContain("setTimeout");
    // The installed build is plain JavaScript: no loader is added to it.
    expect(launched[0]).not.toContain("--import");
  });

  it("refuses to exit when there is no command line to bring the server back", () => {
    let exited = 0;
    const ok = restartServer({ argv: [], launch: () => {}, exit: () => (exited += 1) });
    expect(ok).toBe(false);
    expect(exited).toBe(0);
  });

  it("puts a downloaded bundle in place before the successor starts", () => {
    const launched: string[] = [];
    restartServer({
      argv: ["/app/apps/server/dist/index.js"],
      execArgv: [],
      delayMs: 10,
      applyFrom: "/app/.update-0.1.42",
      launch: (script) => launched.push(script),
      exit: () => {},
    });
    const script = launched[0] ?? "";
    // The chats and a local .env are not part of the build being replaced.
    expect(script).toContain('"/app/.update-0.1.42"');
    expect(script).toContain("const to = path.dirname(from);");
    expect(script).toContain('new Set(["data", ".env", path.basename(from)])');
    // ...and the files are in place before anything starts them.
    expect(script.indexOf("readdirSync")).toBeLessThan(script.indexOf("spawn("));
  });

  it("repeats the argv it was given, not a guessed one", () => {
    const script = restartScript(
      "/usr/bin/node",
      ["/app/apps/server/dist/index.js", "--no-open"],
      750,
      "/app",
    );
    expect(script).toContain('["/app/apps/server/dist/index.js","--no-open"]');
    expect(script).toContain('cwd: "/app"');
    expect(script).toContain("750");
  });

  it("runs a TypeScript entry through tsx, since node cannot load the sources", () => {
    // `tsx` hands the process a rewritten argv: the flags it was started with
    // are gone, so the loader and the development condition go back in.
    const next = restartCommand(["apps/server/src/index.ts"], []);
    expect(next?.args).toEqual([
      "--import",
      "tsx",
      "--conditions=development",
      "apps/server/src/index.ts",
    ]);
    expect(next?.command).toBe(process.execPath);
  });

  it("keeps node flags and extra arguments of a compiled entry", () => {
    const next = restartCommand(["dist/index.js", "--no-open"], ["--enable-source-maps"]);
    expect(next?.args).toEqual(["--enable-source-maps", "dist/index.js", "--no-open"]);
  });
});
