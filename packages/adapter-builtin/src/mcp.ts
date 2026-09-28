// Minimal MCP client for the in-process builtin agent: stdio and streamable
// HTTP, initialize → tools/list → tools/call. The harness hands `mcpServers`
// over ACP at `session/new`, exactly as it does to Cursor/OMP; unlike them we
// have to speak the protocol ourselves.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { tool, jsonSchema, type ToolSet } from "ai";
import type { AskPermission } from "./tools.js";

/** One ACP `mcpServers` entry, normalized. */
export interface McpServerSpec {
  name: string;
  /** stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transport. */
  url?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 180_000;
const MAX_SERVERS = 20;
const MAX_TOOLS_PER_SERVER = 200;
const RESULT_CHAR_LIMIT = 30_000;

/** Tool name the model sees: the `mcp__` prefix is what the transcript strips. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}_${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function asStringRecord(rows: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { name, value } = row as { name?: unknown; value?: unknown };
    if (typeof name === "string" && name.trim()) out[name.trim()] = String(value ?? "");
  }
  return out;
}

/** Accept whatever the harness put in `session/new.mcpServers`; drop the rest. */
export function parseMcpServers(raw: unknown): McpServerSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: McpServerSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || specs.length >= MAX_SERVERS) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const command = typeof row.command === "string" ? row.command.trim() : "";
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!command && !url) continue;
    const env = asStringRecord(row.env);
    const headers = asStringRecord(row.headers);
    specs.push({
      name,
      ...(command ? { command } : {}),
      ...(Array.isArray(row.args) ? { args: row.args.map(String) } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(row.insecureTls === true ? { insecureTls: true } : {}),
    });
  }
  return specs;
}

function clipResult(text: string): string {
  if (text.length <= RESULT_CHAR_LIMIT) return text;
  const head = RESULT_CHAR_LIMIT / 2;
  return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-head)}`;
}

/** MCP `tools/call` content blocks → the text the model reads. */
function renderCallResult(result: unknown): string {
  if (!result || typeof result !== "object") return "(no result)";
  const row = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const parts: string[] = [];
  if (Array.isArray(row.content)) {
    for (const item of row.content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "image") parts.push(`[image ${String(block.mimeType ?? "")}]`);
      else if (block.type === "resource") {
        const uri = (block.resource as { uri?: unknown } | undefined)?.uri;
        parts.push(`[resource ${String(uri ?? "")}]`);
      } else parts.push(`[${String(block.type ?? "content")}]`);
    }
  }
  if (!parts.length && row.structuredContent !== undefined) {
    parts.push(JSON.stringify(row.structuredContent));
  }
  const body = clipResult(parts.join("\n") || "(empty result)");
  return row.isError ? `error: ${body}` : body;
}

/** A streamable-HTTP answer is either raw JSON or an SSE stream of `data:` frames. */
function parseHttpMessages(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (payload: string) => {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // ignore malformed frames
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    push(trimmed);
    return out;
  }
  for (const line of text.split("\n")) {
    const row = line.trim();
    if (row.startsWith("data:")) push(row.slice(5).trim());
  }
  return out;
}

/**
 * One MCP server connection. stdio replies are awaited with `events.once`, so a
 * call that goes quiet past its timeout rejects instead of hanging the turn;
 * `close()` aborts every waiter at once.
 */
class McpConnection {
  private readonly replies = new EventEmitter();
  private readonly lifetime = new AbortController();
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private httpSessionId: string | null = null;
  private agent: Agent | null = null;

  constructor(private readonly spec: McpServerSpec) {}

  async connect(): Promise<McpToolDef[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "acpio-builtin", version: "0.1.0" },
      },
      CONNECT_TIMEOUT_MS,
    );
    this.notify("notifications/initialized", {});
    const listed = (await this.request("tools/list", {}, CONNECT_TIMEOUT_MS)) as {
      tools?: unknown;
    };
    const tools: McpToolDef[] = [];
    if (Array.isArray(listed?.tools)) {
      for (const item of listed.tools.slice(0, MAX_TOOLS_PER_SERVER)) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const name = typeof row.name === "string" ? row.name : "";
        if (!name) continue;
        const annotations = (row.annotations ?? {}) as { readOnlyHint?: unknown };
        tools.push({
          name,
          description: typeof row.description === "string" ? row.description : name,
          inputSchema: row.inputSchema ?? { type: "object", properties: {} },
          readOnly: annotations.readOnlyHint === true,
        });
      }
    }
    return tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    return renderCallResult(result);
  }

  close(): void {
    this.lifetime.abort(new Error(`MCP server ${this.spec.name} closed`));
    this.agent?.destroy();
    this.agent = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    // A stdio server may have children of its own (npx → node).
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────────────────

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    try {
      if (this.spec.url) {
        const messages = await this.postHttp(frame, timeoutMs);
        const answer = messages.find((m) => m.id === id);
        if (!answer) throw new Error(`MCP ${this.spec.name}: no reply to ${method}`);
        return this.settle(answer);
      }
      this.writeStdio(frame);
      const [answer] = (await this.awaitReply(id, method, timeoutMs)) as [Record<string, unknown>];
      return this.settle(answer);
    } catch (err) {
      // An aborted wait rejects as a bare AbortError; the reason we aborted
      // with — exit code, spawn failure, close — is what the model needs.
      const reason = this.lifetime.signal.reason;
      if (this.lifetime.signal.aborted && reason instanceof Error) throw reason;
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`MCP ${this.spec.name}: ${method} timed out after ${timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private awaitReply(id: number, method: string, timeoutMs: number): Promise<unknown[]> {
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), timeoutMs);
    const onClose = () => attempt.abort();
    this.lifetime.signal.addEventListener("abort", onClose, { once: true });
    const done = () => {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", onClose);
    };
    return once(this.replies, `msg:${id}`, { signal: attempt.signal }).finally(done);
  }
  private notify(method: string, params: unknown): void {
    const frame = { jsonrpc: "2.0", method, params };
    try {
      if (this.spec.url) void this.postHttp(frame, CONNECT_TIMEOUT_MS).catch(() => undefined);
      else this.writeStdio(frame);
    } catch {
      // A notification the server never answers is not worth failing the connect.
    }
  }

  /** Resolve a JSON-RPC reply, or throw the server's own error. */
  private settle(msg: Record<string, unknown>): unknown {
    const error = msg.error as { message?: string } | undefined;
    if (error) throw new Error(`${this.spec.name}: ${error.message ?? "MCP error"}`);
    return msg.result;
  }

  /** A server-initiated request we do not implement must still get an answer. */
  private rejectIncoming(msg: Record<string, unknown>): void {
    if (typeof msg.method !== "string" || msg.id === undefined) return;
    const frame = {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Unsupported MCP method: ${msg.method}` },
    };
    if (this.spec.url) void this.postHttp(frame, CONNECT_TIMEOUT_MS).catch(() => undefined);
    else this.writeStdio(frame);
  }

  private writeStdio(frame: unknown): void {
    this.ensureChild().stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child;
    if (this.lifetime.signal.aborted) throw new Error(`MCP server ${this.spec.name} is closed`);
    const command = this.spec.command ?? "";
    const args = this.spec.args ?? [];
    // npm ships CLI servers as `.cmd` shims, which spawn without a shell refuses
    // to execute on Windows.
    const child = spawn(command, args, {
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(command),
    });
    child.on("error", (err) => this.lifetime.abort(new Error(`MCP ${this.spec.name}: ${err.message}`)));
    child.on("exit", (code) =>
      this.lifetime.abort(new Error(`MCP ${this.spec.name} exited with code ${code ?? "null"}`)),
    );
    // A server that dies mid-write gives EPIPE; that must surface as a failed
    // call, not as an unhandled stream error that takes the server down.
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => this.readStdio(chunk));
    this.child = child;
    return child;
  }

  /** MCP stdio framing: one JSON object per line. */
  private readStdio(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let at: number;
    while ((at = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a server that logs to stdout is not a protocol error
      }
      if (msg.method !== undefined) this.rejectIncoming(msg);
      else if (typeof msg.id === "number") this.replies.emit(`msg:${msg.id}`, msg);
    }
  }

  /** One POST per frame; the answer is raw JSON or an SSE stream. */
  private async postHttp(frame: unknown, timeoutMs: number): Promise<Record<string, unknown>[]> {
    const url = this.spec.url;
    if (!url) return [];
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.spec.headers,
    };
    if (this.httpSessionId) headers["mcp-session-id"] = this.httpSessionId;
    const text = await this.postRaw(new URL(url), headers, JSON.stringify(frame), timeoutMs);
    if (!text) return [];
    return parseHttpMessages(text);
  }

  /** One agent per connection: a fresh one per call would leak keep-alive sockets. */
  private insecureAgent(): Agent {
    this.agent ??= new Agent({ rejectUnauthorized: false, keepAlive: true });
    return this.agent;
  }

  /**
   * `fetch` cannot skip certificate verification, and a self-signed internal
   * endpoint is exactly what `insecureTls` exists for — so speak HTTP directly
   * and hand the request an https agent that trusts everything when asked.
   */
  private async postRaw(
    url: URL,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<string> {
    const attempt = new AbortController();
    const timer = setTimeout(() => attempt.abort(), timeoutMs);
    const onClose = () => attempt.abort();
    this.lifetime.signal.addEventListener("abort", onClose, { once: true });
    const secure = url.protocol === "https:";
    const req = (secure ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers,
      signal: attempt.signal,
      ...(secure && this.spec.insecureTls ? { agent: this.insecureAgent() } : {}),
    });
    // `once` already turns an early "error" into a rejection; this keeps a late
    // one (after the response arrived) from crashing the process.
    req.on("error", () => undefined);
    try {
      req.end(body);
      const [res] = (await once(req, "response")) as [IncomingMessage];
      const session = res.headers["mcp-session-id"];
      if (typeof session === "string") this.httpSessionId = session;
      const chunks: Buffer[] = [];
      for await (const chunk of res) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const status = res.statusCode ?? 0;
      if (status >= 400) {
        throw new Error(`MCP ${this.spec.name}: HTTP ${status} ${text.slice(0, 200)}`);
      }
      if (status === 202 || status === 204) return "";
      return text;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", onClose);
    }
  }
}

export interface McpToolEntry extends McpToolDef {
  /** Name the model calls, `mcp__<server>_<tool>`. */
  qualifiedName: string;
  server: string;
  call: (args: Record<string, unknown>) => Promise<string>;
}

/** Connects every configured server and collects its tools; failures degrade. */
export class McpManager {
  private built: { tools: McpToolEntry[]; warnings: string[] } | null = null;
  private readonly connections: McpConnection[] = [];

  constructor(
    private readonly specs: McpServerSpec[],
    private readonly ask: AskPermission,
  ) {}

  async ensure(): Promise<{ tools: McpToolEntry[]; warnings: string[] }> {
    if (this.built) return this.built;
    const tools: McpToolEntry[] = [];
    const warnings: string[] = [];
    await Promise.all(
      this.specs.map(async (spec) => {
        const connection = new McpConnection(spec);
        try {
          const listed = await connection.connect();
          this.connections.push(connection);
          for (const def of listed) {
            tools.push({
              ...def,
              qualifiedName: mcpToolName(spec.name, def.name),
              server: spec.name,
              call: (args) => connection.call(def.name, args),
            });
          }
        } catch (err) {
          connection.close();
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`${spec.name}: ${message}`);
        }
      }),
    );
    this.built = { tools, warnings };
    return this.built;
  }

  close(): void {
    for (const connection of this.connections) connection.close();
    this.connections.length = 0;
    this.built = null;
  }
}

/**
 * Wrap MCP tools as AI SDK tools. Only read-only ones survive plan/ask mode —
 * the same rule the builtin's own write/edit/bash obey.
 */
export function mcpToolSet(
  entries: McpToolEntry[],
  opts: { readOnlyOnly: boolean; ask: AskPermission },
): ToolSet {
  const set: ToolSet = {};
  for (const entry of entries) {
    if (opts.readOnlyOnly && !entry.readOnly) continue;
    set[entry.qualifiedName] = tool({
      description: `${entry.description || entry.name} (MCP server: ${entry.server})`,
      inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args) => {
        if (!entry.readOnly) {
          await opts.ask({
            title: `mcp ${entry.server}: ${entry.name}`,
            kind: "other",
            input: { server: entry.server, tool: entry.name, arguments: args },
          });
        }
        return entry.call((args ?? {}) as Record<string, unknown>);
      },
    });
  }
  return set;
}
