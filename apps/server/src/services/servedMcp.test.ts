import { describe, expect, it } from "vitest";
import { handleServedMcpRequest, type ServedMcpServer } from "./servedMcp.js";

const server = (extra: Partial<ServedMcpServer> = {}): ServedMcpServer => ({
  name: "t",
  tools: [
    {
      name: "slow",
      description: "Answers after a nap",
      inputSchema: { type: "object" },
      readOnly: false,
      call: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 50)),
    },
    {
      name: "echo",
      description: "Echoes",
      inputSchema: { type: "object" },
      readOnly: true,
      call: async (args) => ({ text: String(args.text ?? "") }),
    },
  ],
  ...extra,
});

const ctx = { sessionId: "s1" };
const call = (body: unknown, s: ServedMcpServer = server()) => handleServedMcpRequest(body, s, ctx);

describe("handleServedMcpRequest", () => {
  it("answers initialize with the server's own name", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.status).toBe(200);
    expect((res.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("t");
  });

  it("gives a notification no reply at all", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toEqual({ status: 202, body: null });
  });

  it("answers a batch and skips its notifications", async () => {
    const res = await call([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect((res.body as unknown[]).length).toBe(2);
  });

  it("rejects an unsupported method and a parse error", async () => {
    expect((await call({ jsonrpc: "2.0", id: 1, method: "prompts/list" })).body).toMatchObject({
      error: { code: -32601 },
    });
    expect((await call("nope")).body).toMatchObject({ error: { code: -32700 } });
  });

  it("turns a call that outlives the limit into an error result", async () => {
    const res = await call(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slow", arguments: {} } },
      server({ timeoutMs: 10 }),
    );
    const result = (res.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out");
  });

  it("clips a result to the limit and says how much is missing", async () => {
    const res = await call(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "x".repeat(500) } } },
      server({ clipChars: 100 }),
    );
    const text = (res.body as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("truncated: 400 more characters");
  });
});
