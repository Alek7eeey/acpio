import { describe, expect, it } from "vitest";
import { mergeConsoleEnv, mergeWindowsPath, parseWindowsEnvDump, stringEnv } from "./consoleEnv.js";

describe("stringEnv", () => {
  it("drops undefined values so the map is safe for node-pty", () => {
    expect(stringEnv({ PATH: "C:\\bin", EMPTY: undefined, HOME: "/x" })).toEqual({
      PATH: "C:\\bin",
      HOME: "/x",
    });
  });
});

describe("mergeWindowsPath", () => {
  it("keeps Machine dirs, then User dirs, then parent extras, without duplicates", () => {
    expect(
      mergeWindowsPath(
        "C:\\Windows;C:\\Windows\\System32",
        "C:\\Users\\a\\bin;C:\\Windows",
        "C:\\Windows\\System32;C:\\cursor\\bin",
      ),
    ).toBe("C:\\Windows;C:\\Windows\\System32;C:\\Users\\a\\bin;C:\\cursor\\bin");
  });
});

describe("parseWindowsEnvDump", () => {
  it("splits on the first equals so values may contain '='", () => {
    expect(parseWindowsEnvDump("Path=C:\\a;C:\\b\r\nFOO=bar=baz\n\n")).toEqual({
      Path: "C:\\a;C:\\b",
      FOO: "bar=baz",
    });
  });
});

describe("mergeConsoleEnv", () => {
  it("on Unix clones process env and sets TERM", () => {
    expect(
      mergeConsoleEnv({
        platform: "linux",
        processEnv: { PATH: "/usr/bin", HOME: "/home/a", EMPTY: undefined },
        user: { SECRET: "from-user" },
      }),
    ).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: "/usr/bin",
      HOME: "/home/a",
    });
  });

  it("on Windows merges user/machine vars and rebuilds PATH", () => {
    const env = mergeConsoleEnv({
      platform: "win32",
      processEnv: {
        USERNAME: "alex",
        USERPROFILE: "C:\\Users\\alex",
        PATH: "C:\\Windows;C:\\cursor\\bin",
        CURSOR_SESSION: "1",
      },
      machine: {
        Path: "C:\\Windows;C:\\Windows\\System32",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
      },
      user: {
        Path: "C:\\Users\\alex\\bin",
        CARGO_HOME: "C:\\Users\\alex\\.cargo",
        USERNAME: "stale-from-registry",
      },
    });
    expect(env.CARGO_HOME).toBe("C:\\Users\\alex\\.cargo");
    expect(env.ComSpec).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(env.CURSOR_SESSION).toBe("1");
    expect(env.USERNAME).toBe("alex");
    expect(env.USERPROFILE).toBe("C:\\Users\\alex");
    expect(env.Path).toBe(
      "C:\\Windows;C:\\Windows\\System32;C:\\Users\\alex\\bin;C:\\cursor\\bin",
    );
    expect(env.PATH).toBe(env.Path);
    expect(env.TERM).toBe("xterm-256color");
  });
});
