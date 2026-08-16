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
  listAgentModes,
  type AcpRequest,
  type AcpUpdate,
} from "../src/acp/AcpClient.js";
import { DEFAULT_SETTINGS, type AppSettings } from "@acprocess/shared";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

function makeClient(extra: Partial<AppSettings> = {}): AcpClient {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-client-test-"));
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ompCommand: process.execPath,
    ompArgs: [FAKE_AGENT],
    ...extra,
  };
  return new AcpClient("omp", settings, cwd, "agent");
}

/**
 * Create + start a client, always disposing it — even when the test fails.
 * dispose() kills the child right after end()ing stdin; a stdin write that is
 * still buffered then surfaces as a benign EPIPE on the stdin socket
 * (uncaught on Windows). Swallow it on the client's own stream and give the
 * event loop a turn so the flush lands before the kill.
 */
async function withClient<T>(run: (client: AcpClient) => Promise<T>): Promise<T> {
  const client = makeClient();
  // `proc` is a TS-private field; the cast only reaches the real child stream.
  const acp = client as unknown as { proc: { stdin: NodeJS.WritableStream } | null };
  try {
    await client.start();
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
