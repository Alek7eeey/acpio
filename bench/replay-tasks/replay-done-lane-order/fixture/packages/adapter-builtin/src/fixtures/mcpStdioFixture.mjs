// Minimal MCP stdio server used by mcp.test.ts: one read-only and one mutating
// tool, plus the initialize / tools/list handshake.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "commit",
    description: "Pretend to write something",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications/initialized
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      },
    });
  }
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === "tools/call") {
    // Used by mcp.test.ts: a server that dies mid-call must reject the call
    // instead of hanging the turn.
    if (process.env.FIXTURE_DIE_ON_CALL) process.exit(1);
    const text =
      msg.params?.name === "echo" ? `<${msg.params.arguments?.text ?? ""}>` : "committed";
    return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
});
