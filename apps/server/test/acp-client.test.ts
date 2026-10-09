// Integration tests: AcpClient against the real fake ACP agent process
// (apps/server/test/fake-agent.mjs). Each test spawns a real child process
// and talks NDJSON over stdio — no mocks, no fakes in the test.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  AcpRpcError,
  listAgentModes,
  type AcpRequest,
  type AcpUpdate,
} from "../src/acp/AcpClient.js";
import { getAdapter } from "../src/adapters/registry.js";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

function makeClient(extra: Partial<AppSettings> = {}, provider: "cursor" | "omp" = "omp"): AcpClient {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-client-test-"));
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(provider === "omp"
      ? { ompCommand: process.execPath, ompArgs: [FAKE_AGENT] }
      : { cursorCommand: process.execPath, cursorArgs: [FAKE_AGENT] }),
    ...extra,
  };
  return new AcpClient(getAdapter(provider), settings, cwd, "agent");
}

/**
 * Create + start a client, always disposing it — even when the test fails.
 * dispose() kills the child right after end()ing stdin; a stdin write that is
 * still buffered then surfaces as a benign EPIPE on the stdin socket
 * (uncaught on Windows). Swallow it on the client's own stream and give the
 * event loop a turn so the flush lands before the kill.
 */
async function withClient<T>(run: (client: AcpClient) => Promise<T>): Promise<T> {
  return withClientStart(run);
}

/** Like withClient, but boots with the given start opts (resume/load). */
async function withClientStart<T>(
  run: (client: AcpClient) => Promise<T>,
  startOpts?: { resume?: { sessionId: string; mode: "resume" | "load" } },
): Promise<T> {
  const client = makeClient();
  // `proc` is a TS-private field; the cast only reaches the real child stream.
  const acp = client as unknown as { proc: { stdin: NodeJS.WritableStream } | null };
  try {
    await client.start(120_000, startOpts);
    acp.proc?.stdin.on("error", () => {
      // benign: teardown raced a pending stdin write
    });
    return await run(client);
  } finally {
    await new Promise((r) => setTimeout(r, 25));
    client.dispose();
  }
}

describe("AcpClient against the fake agent", () => {
  it("start() sets sessionId to fake-sess-N and populates configOptions", async () => {
    await withClient(async (client) => {
      expect(client.sessionId).toMatch(/^fake-sess-\d+$/);
      expect(client.configOptions.length).toBeGreaterThan(0);
      expect(client.configOptions.map((o) => o.id)).toEqual(
        expect.arrayContaining(["model", "mode"]),
      );
    });
  });

  it("start() exposes the fake agent's initial model and mode options", async () => {
    await withClient(async (client) => {
      const model = client.configOptions.find((o) => o.id === "model");
      expect(model?.currentValue).toBe("fake-model");
      expect(model?.options?.map((o) => o.value)).toEqual(["fake-model", "other"]);
      const mode = client.configOptions.find((o) => o.id === "mode");
      expect(mode?.currentValue).toBe("default");
      expect(mode?.options?.map((o) => o.value)).toEqual(["default"]);
    });
  });

  it("prompt('hello') resolves with stopReason 'end_turn'", async () => {
    await withClient(async (client) => {
      const result = await client.prompt("hello");
      expect(result.stopReason).toBe("end_turn");
    });
  });

  it("prompt('hello') emits agent_message_chunk with 'echo: hello'", async () => {
    await withClient(async (client) => {
      const chunks: string[] = [];
      client.on("update", (u: AcpUpdate) => {
        if (u.kind === "agent_message_chunk") chunks.push(u.text);
      });
      await client.prompt("hello");
      expect(chunks).toEqual(["echo: hello"]);
    });
  });

  it("prompt('PLACEHOLDER') drops the harness empty-message filler, keeps the thought", async () => {
    await withClient(async (client) => {
      const chunks: string[] = [];
      const thoughts: string[] = [];
      client.on("update", (u: AcpUpdate) => {
        if (u.kind === "agent_message_chunk") chunks.push(u.text);
        if (u.kind === "agent_thought_chunk") thoughts.push(u.text);
      });
      await client.prompt("PLACEHOLDER");
      expect(chunks).toEqual([]);
      expect(thoughts).toEqual(["worked, said nothing"]);
    });
  });

  it("prompt('hello') emits agent_thought_chunk with 'thinking hard'", async () => {
    await withClient(async (client) => {
      const thoughts: string[] = [];
      client.on("update", (u: AcpUpdate) => {
        if (u.kind === "agent_thought_chunk") thoughts.push(u.text);
      });
      await client.prompt("hello");
      expect(thoughts).toEqual(["thinking hard"]);
    });
  });

  it("two sequential prompts in one session both echo their own text", async () => {
    await withClient(async (client) => {
      const first = await client.prompt("first");
      expect(first.stopReason).toBe("end_turn");

      const echoes: string[] = [];
      client.on("update", (u: AcpUpdate) => {
        if (u.kind === "agent_message_chunk") echoes.push(u.text);
      });
      const second = await client.prompt("second");
      expect(second.stopReason).toBe("end_turn");
      expect(echoes).toEqual(["echo: second"]);
    });
  });

  it("setConfigOption('model', 'other') is reflected in configOptions", async () => {
    await withClient(async (client) => {
      await client.setConfigOption("model", "other");
      const model = client.configOptions.find((o) => o.id === "model");
      expect(model?.currentValue).toBe("other");
    });
  });

  it("setConfigOption('model', 'other') leaves the mode option untouched", async () => {
    await withClient(async (client) => {
      await client.setConfigOption("model", "other");
      const mode = client.configOptions.find((o) => o.id === "mode");
      expect(mode?.currentValue).toBe("default");
    });
  });

  it("setMode('agent') rejects when the agent only exposes 'default'", async () => {
    await withClient(async (client) => {
      const modes = listAgentModes(client.configOptions, "omp", client.sessionModes);
      expect(modes.map((m) => m.value)).toEqual(["default"]);
      await expect(client.setMode("agent")).rejects.toThrow(/Unsupported mode: agent/);
    });
  });

  it("setMode('default') succeeds", async () => {
    await withClient(async (client) => {
      await expect(client.setMode("default")).resolves.toBeUndefined();
    });
  });

  it("PERMISSION prompt emits a request event with the prompt text", async () => {
    await withClient(async (client) => {
      const requestPromise = once(client, "request") as Promise<[AcpRequest]>;
      const promptPromise = client.prompt("PERMISSION: open file?");
      const [request] = await requestPromise;
      expect(request.kind).toBe("permission");
      expect(typeof request.id).toBe("string");
      expect(request.params.sessionId).toBe(client.sessionId);
      const req =
        request.params.request && typeof request.params.request === "object"
          ? request.params.request
          : undefined;
      const message =
        req && "message" in req ? String(req.message) : undefined;
      // The fake slices after the "PERMISSION:" prefix, keeping the space.
      expect(message).toBe(" open file?");
      client.respond(request.id, { optionId: "allow-once" });
      await promptPromise;
    });
  });

  it.each(["allow-once", "allow-always"])(
    "respond(id, {optionId:'%s'}) resolves the PERMISSION prompt with permissionDecision",
    async (optionId) => {
      await withClient(async (client) => {
        const requestPromise = once(client, "request") as Promise<[AcpRequest]>;
        const promptPromise = client.prompt("PERMISSION: open file?");
        const [request] = await requestPromise;
        expect(request.kind).toBe("permission");
        client.respond(request.id, { optionId });
        const result = await promptPromise;
        expect(result.stopReason).toBe("end_turn");
        const raw = result.raw;
        const decision =
          raw && typeof raw === "object" && "permissionDecision" in raw
            ? raw.permissionDecision
            : undefined;
        expect(decision).toEqual({ optionId });
      });
    },
  );

  it("FAKE_PROMPT_ERROR=1 makes prompt reject with 'fake prompt failure'", async () => {
    process.env.FAKE_PROMPT_ERROR = "1";
    try {
      await withClient(async (client) => {
        await expect(client.prompt("hello")).rejects.toThrow("fake prompt failure");
      });
    } finally {
      delete process.env.FAKE_PROMPT_ERROR;
    }
  });

  it("EXIT-NOW prompt emits exit and rejects the pending prompt", async () => {
    await withClient(async (client) => {
      const exitPromise = once(client, "exit") as Promise<
        [{ code: number | null; signal: string | null }]
      >;
      const promptPromise = client.prompt("EXIT-NOW");
      await expect(promptPromise).rejects.toThrow(/ACP process exited/);
      const [exitInfo] = await exitPromise;
      expect(exitInfo.code).toBe(1);
    });
  });

  it("extends request timeout while the agent keeps sending updates", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        // Arm the short ceiling only after initialize: spawn+handshake is not
        // what this test is about, and under full-suite load it can exceed 80ms.
        AcpClient.requestTimeoutMs = 80;
        const result = await client.prompt("SLOW-ACTIVE please");
        expect(result.stopReason).toBe("end_turn");
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("times out a prompt that stays silent past the idle ceiling", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        await expect(client.prompt("SLOW-SILENT please")).rejects.toThrow(/Таймаут ответа ACP/);
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("never times out a prompt while the agent waits for a user answer", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        const requestPromise = once(client, "request") as Promise<[AcpRequest]>;
        const promptPromise = client.prompt("ELICIT: pick a colour");
        const [request] = await requestPromise;
        expect(request.kind).toBe("elicitation");
        // Quieten far past the idle ceiling. The agent is parked on the USER,
        // not hung — the prompt must stay alive however long the answer takes.
        await new Promise((r) => setTimeout(r, 250));
        const raced = await Promise.race([
          promptPromise.then(() => "settled"),
          new Promise((r) => setTimeout(() => r("still pending"), 20)),
        ]);
        expect(raced).toBe("still pending");
        client.respond(request.id, { action: "accept", content: { answer: "green" } });
        const result = await promptPromise;
        expect(result.stopReason).toBe("end_turn");
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("times out again after an answered request releases the exemption", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        const requestPromise = once(client, "request") as Promise<[AcpRequest]>;
        const first = client.prompt("ELICIT: pick a colour");
        const [request] = await requestPromise;
        client.respond(request.id, { action: "accept", content: { answer: "green" } });
        await first;
        // Stale exemption would silently disable the hang detector for good.
        await expect(client.prompt("SLOW-SILENT please")).rejects.toThrow(/Таймаут ответа ACP/);
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  // The 2026-10-08 incident: a `[js]` tool call runs a model request for
  // 5–15 minutes without a single frame on the wire, and the idle ceiling
  // killed session/prompt mid-turn ("агент останавливается").
  it("never times out a prompt while the agent has a tool in progress", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        // Tool runs silent for 300ms — many idle ceilings — then closes and
        // the turn ends. Without the active-tool exemption this rejects with
        // "Таймаут ответа ACP" (the negative control).
        const result = await client.prompt("TOOL-SILENT please");
        expect(result.stopReason).toBe("end_turn");
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("times out once a tool has finished and the line went quiet", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        // The tool closes immediately — the exemption must be released, not
        // latched, or a silent agent after a tool would hang forever.
        await expect(client.prompt("TOOL-THEN-SILENT please")).rejects.toThrow(
          /Таймаут ответа ACP/,
        );
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("a tool left open by a finished turn does not exempt the next prompt", async () => {
    const prev = AcpClient.requestTimeoutMs;
    try {
      await withClient(async (client) => {
        AcpClient.requestTimeoutMs = 80;
        const first = await client.prompt("TOOL-NOEND please");
        expect(first.stopReason).toBe("end_turn");
        // The open tool_call never got a terminal update — stale tracking
        // would disable the hang detector for the rest of the session.
        await expect(client.prompt("SLOW-SILENT please")).rejects.toThrow(/Таймаут ответа ACP/);
      });
    } finally {
      AcpClient.requestTimeoutMs = prev;
    }
  });

  it("a session_busy rejection keeps its JSON-RPC code and data for callers", async () => {
    process.env.FAKE_PROMPT_BUSY = "1";
    try {
      await withClient(async (client) => {
        let caught: unknown;
        try {
          await client.prompt("hello");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(AcpRpcError);
        const rpc = caught as AcpRpcError;
        expect(rpc.message).toMatch(/Agent is already processing/);
        expect(rpc.code).toBe(-32003);
        expect(rpc.data).toEqual({ reason: "session_busy", hint: "steer|followUp|wait" });
      });
    } finally {
      delete process.env.FAKE_PROMPT_BUSY;
    }
  });

  it("cancel() mid-prompt resolves the prompt with stopReason 'cancelled'", async () => {
    await withClient(async (client) => {
      const promptPromise = client.prompt("hello");
      await client.cancel();
      const result = await promptPromise;
      expect(result.stopReason).toBe("cancelled");
    });
  });

  it("cancel() with nothing in flight resolves without throwing", async () => {
    await withClient(async (client) => {
      await expect(client.cancel()).resolves.toBeUndefined();
    });
  });

  it("prompt() before start rejects with 'ACP session not started'", async () => {
    const client = makeClient();
    try {
      await expect(client.prompt("hello")).rejects.toThrow("ACP session not started");
    } finally {
      client.dispose();
    }
  });

  it("setConfigOption() before start rejects with 'no session'", async () => {
    const client = makeClient();
    try {
      await expect(client.setConfigOption("model", "other")).rejects.toThrow("no session");
    } finally {
      client.dispose();
    }
  });
});

describe("session restore (resume/load)", () => {
  it("session/resume boot attaches to the requested session and keeps prompting", async () => {
    await withClientStart(
      async (client) => {
        expect(client.sessionId).toBe("fake-sess-1");
        expect(client.canResumeSession).toBe(true);
        const updates: AcpUpdate[] = [];
        client.on("update", (u) => updates.push(u));
        const res = await client.prompt("hello after resume");
        expect(res.stopReason).toBe("end_turn");
        expect(updates.some((u) => u.kind === "agent_message_chunk")).toBe(true);
      },
      { resume: { sessionId: "fake-sess-1", mode: "resume" } },
    );
  });

  it("session/load boot swallows the replayed history (no update events)", async () => {
    // Cursor's adapter declares suppressReplayOnLoad — history already stored.
    const client = makeClient({}, "cursor");
    const updates: AcpUpdate[] = [];
    client.on("update", (u) => updates.push(u));
    try {
      await client.start(120_000, {
        resume: { sessionId: "fake-sess-1", mode: "load" },
      });
      expect(client.sessionId).toBe("fake-sess-1");
      expect(client.canLoadSession).toBe(true);
      // The fake replays two session/update notifications during session/load —
      // they must never reach consumers (the history is already in our DB).
      expect(updates).toHaveLength(0);
      const res = await client.prompt("still works after load");
      expect(res.stopReason).toBe("end_turn");
    } finally {
      client.dispose();
    }
  });

  it("resume of an unknown session id rejects", async () => {
    await expect(
      withClientStart(
        async () => {},
        { resume: { sessionId: "unknown-id", mode: "resume" } },
      ),
    ).rejects.toThrow("ACP session not found");
  });

  it("load of an unknown session id rejects", async () => {
    await expect(
      withClientStart(
        async () => {},
        { resume: { sessionId: "unknown-id", mode: "load" } },
      ),
    ).rejects.toThrow("ACP session not found");
  });
});

describe("model preservation on restart", () => {
  it("start with a model override applies it (MCP-change restart keeps the model)", async () => {
    const client = makeClient();
    try {
      await client.start(120_000, { model: "other" });
      const modelOpt = client.configOptions.find((o) => o.id === "model");
      expect(modelOpt?.currentValue).toBe("other");
    } finally {
      client.dispose();
    }
  });

  it("resume boot with a model override keeps the session AND the model", async () => {
    await withClientStart(
      async (client) => {
        expect(client.sessionId).toBe("fake-sess-1");
        const modelOpt = client.configOptions.find((o) => o.id === "model");
        expect(modelOpt?.currentValue).toBe("other");
      },
      {
        resume: { sessionId: "fake-sess-1", mode: "resume" },
        model: "other",
      },
    );
  });
});
