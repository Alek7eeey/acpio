/**
 * JSON-RPC framing for the MCP servers acpio serves itself over HTTP: one
 * endpoint per server, one tool table each, the same `initialize` /
 * `tools/list` / `tools/call` handling (`/api/mcp/bg`, `/api/mcp/plugin/...`).
 *
 * It is spoken over HTTP because every harness acpio drives already knows how
 * to talk to an HTTP MCP server — the built-in agent has its own client in
 * `@acpio/adapter-builtin`, omp, cursor and opencode take the same
 * `session/new` entry — so one endpoint serves them all.
 */

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";

export interface ServedMcpContext {
  /** Chat the call belongs to ("" when the server is not per-chat). */
  sessionId: string;
}

export interface ServedToolResult {
  text: string;
  /** The model sees a failed call instead of a broken session. */
  isError?: boolean;
}

export interface ServedMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Clients may skip a confirmation prompt for a read-only tool. */
  readOnly: boolean;
  call(args: Record<string, unknown>, ctx: ServedMcpContext): Promise<ServedToolResult>;
}

export interface ServedMcpServer {
  /** `serverInfo.name`; clients also cut it into the `mcp__<server>_<tool>` name. */
  name: string;
  tools: ServedMcpTool[];
  /** Cut a result to this many characters. Unset = as is. */
  clipChars?: number;
  /** Answer a call that takes longer than this with an error. Unset = no limit. */
  timeoutMs?: number;
}

export interface ServedMcpResponse {
  /** HTTP status the route answers with. */
  status: number;
  /** JSON body, or null for a notification (answered with an empty 202). */
  body: unknown;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function clip(text: string, limit: number | undefined): string {
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated: ${text.length - limit} more characters)`;
}

/**
 * `shortcut:` a timed-out call is reported but not cancelled — the handler
 * keeps running. Give handlers an AbortSignal when a tool can hang on purpose.
 */
function withTimeout<T>(work: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (!ms) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`"${label}" timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolList(server: ServedMcpServer) {
  return server.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Only the read-only hint is sent: a client treats an absent one as
    // "not read-only", so a tool that does not write says so and nothing else.
    ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));
}

async function callTool(
  server: ServedMcpServer,
  name: string,
  args: Record<string, unknown>,
  ctx: ServedMcpContext,
) {
  const tool = server.tools.find((t) => t.name === name);
  if (!tool) {
    const names = server.tools.map((t) => t.name).join(", ");
    return textResult(`Unknown tool "${name}". Available tools: ${names}.`, true);
  }
  try {
    const result = await withTimeout(tool.call(args, ctx), server.timeoutMs, tool.name);
    return textResult(clip(result.text, server.clipChars), result.isError === true);
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err), true);
  }
}

/** One JSON-RPC frame in, one answer (or none, for a notification) out. */
async function handleMessage(
  server: ServedMcpServer,
  message: JsonRpcMessage,
  ctx: ServedMcpContext,
): Promise<unknown | null> {
  const method = typeof message.method === "string" ? message.method : "";
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: server.name, version: SERVER_VERSION },
    });
  }
  if (method === "ping") return isNotification ? null : ok(id, {});
  if (method.startsWith("notifications/")) return null;
  if (method === "tools/list") return ok(id, { tools: toolList(server) });
  if (method === "tools/call") {
    const params = message.params ?? {};
    const name = asString(params.name).trim();
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) return fail(id, -32602, "tools/call requires a tool name");
    return ok(id, await callTool(server, name, args, ctx));
  }
  if (!method) return fail(id, -32600, "Missing method");
  return fail(id, -32601, `Unsupported method: ${method}`);
}

/** Serve one MCP request against one tool table. */
export async function handleServedMcpRequest(
  payload: unknown,
  server: ServedMcpServer,
  ctx: ServedMcpContext,
): Promise<ServedMcpResponse> {
  if (Array.isArray(payload)) {
    const answers: unknown[] = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const answer = await handleMessage(server, item as JsonRpcMessage, ctx);
      if (answer) answers.push(answer);
    }
    return answers.length ? { status: 200, body: answers } : { status: 202, body: null };
  }
  if (!payload || typeof payload !== "object") {
    return { status: 200, body: fail(null, -32700, "Parse error: expected a JSON-RPC object") };
  }
  const answer = await handleMessage(server, payload as JsonRpcMessage, ctx);
  return answer ? { status: 200, body: answer } : { status: 202, body: null };
}
