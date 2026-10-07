import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastToSession } from "./wsHub.js";
import {
  attachUserConsole,
  releaseUserConsole,
  resetUserConsole,
  reviveUserConsole,
  writeUserConsole,
} from "./userConsole.js";

type FakeProc = {
  writes: string[];
  killed: boolean;
  data: ((chunk: string) => void) | null;
  exit: (() => void) | null;
};

const spawned: FakeProc[] = [];

vi.mock("node-pty", () => ({
  spawn: () => {
    const proc: FakeProc & {
      write: (data: string) => void;
      resize: () => void;
      kill: () => void;
      onData: (cb: (chunk: string) => void) => void;
      onExit: (cb: () => void) => void;
    } = {
      writes: [],
      killed: false,
      data: null,
      exit: null,
      write: (data: string) => {
        proc.writes.push(data);
      },
      resize: () => {},
      kill: () => {
        proc.killed = true;
      },
      onData: (cb) => {
        proc.data = cb;
      },
      onExit: (cb) => {
        proc.exit = cb;
      },
    };
    spawned.push(proc);
    return proc;
  },
}));

vi.mock("./consoleEnv.js", () => ({ getConsoleEnv: async () => ({}) }));
vi.mock("./settings.js", () => ({ getSettings: async () => ({ terminalShell: "cmd" }) }));
vi.mock("./wsHub.js", () => ({ broadcastToSession: vi.fn() }));

const broadcast = vi.mocked(broadcastToSession);
const SESSION_IDS = ["s-race", "s-exit", "s-young", "s-revive"];

beforeEach(() => {
  // The console keeps its own clock: shells have a spawn time and a revive has a
  // cooldown, so tests drive time instead of sleeping through it.
  vi.useFakeTimers();
  // Past the revive cooldown: the clock itself must not suppress the first revive.
  vi.setSystemTime(1_000_000);
  spawned.length = 0;
  broadcast.mockClear();
});

afterEach(() => {
  for (const id of SESSION_IDS) releaseUserConsole(id);
  vi.useRealTimers();
});

describe("userConsole lifecycle", () => {
  it("ignores the late output and exit of the shell it just replaced", async () => {
    await attachUserConsole("s-race", process.cwd(), "cmd");
    const first = spawned[0];
    await resetUserConsole("s-race", process.cwd());
    const second = spawned[1];
    expect(first.killed).toBe(true);
    broadcast.mockClear();

    // ConPTY teardown lands after the fresh shell is already running.
    first.data?.("stale-output");
    first.exit?.();
    await vi.advanceTimersByTimeAsync(50);

    // The fresh shell survived, took the keystroke, and nothing stale was shown.
    expect(second.killed).toBe(false);
    expect(writeUserConsole("s-race", "echo hi\r")).toBe(true);
    expect(second.writes).toEqual(["echo hi\r"]);
    expect(broadcast.mock.calls.filter(([, event]) => event.type === "process.output")).toEqual([]);
  });

  it("restarts the panel when a working shell exits on its own", async () => {
    await attachUserConsole("s-exit", process.cwd(), "cmd");
    broadcast.mockClear();

    vi.setSystemTime(1_002_000);
    spawned[0].exit?.();

    expect(broadcast).toHaveBeenCalledWith("s-exit", { type: "process.cleared", sessionId: "s-exit" });
    expect(writeUserConsole("s-exit", "x")).toBe(false);
    await attachUserConsole("s-exit", process.cwd(), "cmd");
    expect(spawned).toHaveLength(2);
  });

  it("stays quiet when the shell never got to work, so a broken profile cannot spin", async () => {
    await attachUserConsole("s-young", process.cwd(), "cmd");
    broadcast.mockClear();

    spawned[0].exit?.();

    expect(broadcast).not.toHaveBeenCalled();
    expect(writeUserConsole("s-young", "x")).toBe(false);
  });

  it("starts a shell for input that arrives without one, once per cooldown", async () => {
    expect(writeUserConsole("s-revive", "echo hi\r")).toBe(false);

    await reviveUserConsole("s-revive", process.cwd());
    expect(spawned).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith("s-revive", { type: "process.cleared", sessionId: "s-revive" });

    releaseUserConsole("s-revive");
    broadcast.mockClear();
    await reviveUserConsole("s-revive", process.cwd());
    expect(spawned).toHaveLength(1);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
