import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { McpManager, mcpToolName, mcpToolSet, parseMcpServers } from "./mcp.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcpStdioFixture.mjs", import.meta.url));
const stdioSpec = { name: "fixture", command: process.execPath, args: [FIXTURE] };

const ask: Mock = vi.fn(async () => undefined);
const managers: McpManager[] = [];
const servers: Server[] = [];

function manager(specs: unknown[]) {
  const m = new McpManager(parseMcpServers(specs), ask);
  managers.push(m);
  return m;
}

afterEach(async () => {
  for (const m of managers.splice(0)) m.close();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  ask.mockClear();
});

describe("parseMcpServers", () => {
  it("keeps command and url servers, normalizes env/headers", () => {
    const specs = parseMcpServers([
      { name: "a", command: "npx", args: ["-y", "srv"], env: [{ name: "K", value: "V" }] },
      { name: "b", url: "http://localhost:9/mcp", headers: [{ name: "X", value: "1" }] },
    ]);
    expect(specs).toEqual([
      { name: "a", command: "npx", args: ["-y", "srv"], env: { K: "V" } },
      { name: "b", url: "http://localhost:9/mcp", headers: { X: "1" } },
    ]);
  });

  it("drops entries with no name or no transport", () => {
    expect(parseMcpServers([{ name: "x" }, { command: "npx" }, null, "junk"])).toEqual([]);
    expect(parseMcpServers(undefined)).toEqual([]);
  });
});

describe("McpManager", () => {
  it("names tools mcp__<server>_<tool>", () => {
    expect(mcpToolName("my srv", "echo-now")).toBe("mcp__my_srv_echo-now");
  });

  it("connects over stdio and exposes the server's tools", async () => {
    const { tools, warnings } = await manager([stdioSpec]).ensure();
    expect(warnings).toEqual([]);
    expect(tools.map((t) => t.qualifiedName)).toEqual(["mcp__fixture_echo", "mcp__fixture_commit"]);
    expect(tools[0]!.readOnly).toBe(true);
    expect(tools[1]!.readOnly).toBe(false);
  });

  it("keeps both tools when two servers' names collide after sanitising", async () => {
    const { tools } = await manager([
      {
        name: "a b",
        command: process.execPath,
        args: [FIXTURE],
        env: [{ name: "FIXTURE_TOOLS", value: "echo" }],
      },
      {
        name: "a",
        command: process.execPath,
        args: [FIXTURE],
        env: [{ name: "FIXTURE_TOOLS", value: "b_echo" }],
      },
    ]).ensure();
    expect(tools.map((t) => t.qualifiedName).sort()).toEqual(["mcp__a_b_echo", "mcp__a_b_echo_2"]);
    expect(Object.keys(mcpToolSet(tools, { ask }))).toHaveLength(2);
  });

  it("calls a tool and returns its text content", async () => {
    const { tools } = await manager([stdioSpec]).ensure();
    await expect(tools[0]!.call({ text: "hi" })).resolves.toEqual({ text: "<hi>", images: [] });
  });

  it("reports an unreachable server as a warning instead of failing", async () => {
    const { tools, warnings } = await manager([
      { name: "dead", command: "definitely-not-a-real-binary-xyz" },
      stdioSpec,
    ]).ensure();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^dead: /);
    expect(tools.map((t) => t.qualifiedName)).toEqual(["mcp__fixture_echo", "mcp__fixture_commit"]);
  });

  it("rejects a call when the server dies mid-flight instead of hanging", async () => {
    const { tools } = await manager([
      {
        name: "fixture",
        command: process.execPath,
        args: [FIXTURE],
        env: [{ name: "FIXTURE_DIE_ON_CALL", value: "1" }],
      },
    ]).ensure();
    await expect(tools[0]!.call({ text: "hi" })).rejects.toThrow(/exited|closed/i);
  });

  it("connects over streamable HTTP", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
          method: string;
        };
        const results: Record<string, unknown> = {
          initialize: { protocolVersion: "2024-11-05", capabilities: {} },
          "tools/list": {
            tools: [
              {
                name: "lookup",
                description: "Look something up",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
            ],
          },
          "tools/call": { content: [{ type: "text", text: "found" }] },
        };
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "s1");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: results[msg.method] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const { tools, warnings } = await manager([
      { name: "web", url: `http://127.0.0.1:${port}/mcp` },
    ]).ensure();
    expect(warnings).toEqual([]);
    expect(tools.map((t) => t.qualifiedName)).toEqual(["mcp__web_lookup"]);
    await expect(tools[0]!.call({})).resolves.toEqual({ text: "found", images: [] });
  });

  it("keeps an image block as bytes instead of a placeholder", async () => {
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        const results: Record<string, unknown> = {
          initialize: { protocolVersion: "2024-11-05", capabilities: {} },
          "tools/list": { tools: [{ name: "shot", inputSchema: { type: "object" } }] },
          "tools/call": {
            content: [
              { type: "text", text: "rendered" },
              { type: "image", data: PNG, mimeType: "image/png" },
            ],
          },
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: results[msg.method] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const { tools } = await manager([{ name: "cad", url: `http://127.0.0.1:${port}/mcp` }]).ensure();
    await expect(tools[0]!.call({})).resolves.toEqual({
      text: "rendered",
      images: [{ data: PNG, mimeType: "image/png" }],
    });
  });

  it("connects to a self-signed HTTPS endpoint when insecureTls is set", async () => {
    const cert = readFileSync(new URL("./fixtures/mcpTlsCert.pem", import.meta.url));
    const key = readFileSync(new URL("./fixtures/mcpTlsKey.pem", import.meta.url));
    const server = createHttpsServer({ cert, key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        const results: Record<string, unknown> = {
          initialize: { protocolVersion: "2024-11-05", capabilities: {} },
          "tools/list": { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: results[msg.method] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `https://127.0.0.1:${port}/mcp`;

    // Without the flag the handshake must fail: the cert is not trusted.
    const strict = await manager([{ name: "tls", url }]).ensure();
    expect(strict.tools).toEqual([]);
    expect(strict.warnings[0]).toMatch(/self-signed|unable to verify/i);

    const relaxed = await manager([{ name: "tls", url, insecureTls: true }]).ensure();
    expect(relaxed.warnings).toEqual([]);
    expect(relaxed.tools.map((t) => t.qualifiedName)).toEqual(["mcp__tls_ping"]);
  });
});

describe("mcpToolSet", () => {
  it("hands a tool's images to the turn loop and returns only text to the model", async () => {
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const images: Array<[string, unknown]> = [];
    const set = mcpToolSet(
      [
        {
          name: "shot",
          description: "render",
          inputSchema: { type: "object" },
          readOnly: true,
          qualifiedName: "mcp__cad_shot",
          server: "cad",
          call: async () => ({ text: "rendered", images: [{ data: PNG, mimeType: "image/png" }] }),
        },
      ],
      { ask, onImages: (toolCallId, imgs) => images.push([toolCallId, imgs]) },
    );
    const execute = (
      set["mcp__cad_shot"] as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    ).execute;
    await expect(execute({}, { toolCallId: "call-7" })).resolves.toBe("rendered");
    expect(images).toEqual([["call-7", [{ data: PNG, mimeType: "image/png" }]]]);
  });

  it("offers every tool and asks before a mutating one", async () => {
    const { tools } = await manager([stdioSpec]).ensure();
    const all = mcpToolSet(tools, { ask });
    expect(Object.keys(all)).toEqual(["mcp__fixture_echo", "mcp__fixture_commit"]);
    await (all["mcp__fixture_commit"] as { execute: (i: unknown, o: unknown) => Promise<unknown> })
      .execute({}, { abortSignal: new AbortController().signal });
    expect(ask).toHaveBeenCalledWith({
      title: "mcp fixture: commit",
      kind: "other",
      input: { server: "fixture", tool: "commit", arguments: {} },
    });
  });
});
