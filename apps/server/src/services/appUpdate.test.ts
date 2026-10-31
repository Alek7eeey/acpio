// The updater against a stub registry: which number counts as a new version,
// how often it is asked, and what the popup sees while npm works — never the
// real npm and never the real registry.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createAppUpdater,
  installCommand,
  restartCommand,
  restartServer,
  restartScript,
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

function updater(options: {
  current?: string;
  runInstall?: (version: string) => Promise<InstallOutcome>;
  now?: () => number;
}) {
  return createAppUpdater({ registryUrl: base, current: "0.1.41", ...options });
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
