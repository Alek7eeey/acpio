import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** The bit of a WebSocket this bridge needs; keeps it testable without a server. */
export type LspSocket = {
  send(data: string): void;
  close(): void;
  /** 1 = open; a pane that left before its tools were read must not spawn one. */
  readyState?: number;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
};

/** One language server as the tasks page sees it: what it serves, what it costs. */
export type EditorServerDto = {
  id: number;
  root: string;
  project: string;
  source: "auto" | "project" | "bundled";
  pid: number;
  startedAt: number;
};

const running = new Map<number, { dto: EditorServerDto; child: ChildProcess; socket: LspSocket }>();
let nextId = 1;

/** Everything the server holds for open panes — the number the page frees. */
export function listEditorServers(): EditorServerDto[] {
  return [...running.values()].map((entry) => ({ ...entry.dto }));
}

/** Kill one pane's server tree and drop its socket: the pane sees it go. */
export function killEditorServer(id: number): boolean {
  const entry = running.get(id);
  if (!entry) return false;
  stopServer(entry.child);
  running.delete(id);
  try {
    entry.socket.close();
  } catch {
    // already gone
  }
  return true;
}

export function killAllEditorServers(): number {
  let killed = 0;
  // Deleting the current entry is allowed while iterating a Map.
  for (const id of running.keys()) if (killEditorServer(id)) killed += 1;
  return killed;
}

function tslsEntry(): string {
  const pkg = require.resolve("typescript-language-server/package.json");
  return path.join(path.dirname(pkg), "lib", "cli.mjs");
}

/** LSP over stdio wants a length header; the browser speaks bare JSON-RPC frames. */
function frame(json: string): string {
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

/**
 * The project's own TypeScript, not the copy bundled with the language server:
 * a pane that flags code against a different compiler version than the build is
 * worse than no pane. The settings can override that per tool — see
 * `editorToolTypescript`.
 */
function projectTsserver(dir: string): string | null {
  try {
    return require.resolve("typescript/lib/tsserver.js", { paths: [dir] });
  } catch {
    return null;
  }
}

function injectTsserver(json: string, tsserverPath: string): string | null {
  let msg: { method?: string; params?: { initializationOptions?: Record<string, unknown> } };
  try {
    msg = JSON.parse(json);
  } catch {
    return null;
  }
  if (msg.method !== "initialize" || !msg.params) return null;
  msg.params.initializationOptions = { ...msg.params.initializationOptions, tsserver: { path: tsserverPath } };
  return JSON.stringify(msg);
}

/**
 * The language server spawns its own tsserver child, and Windows leaves
 * grandchildren alive when only the head is killed — so the tree goes.
 */
function stopServer(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill();
}

/**
 * Resident bytes of each server and its descendants — the number the tasks page
 * frees. One process listing per call: a diagnostics read, not a hot path.
 */
export async function editorServerMemory(pids: number[]): Promise<Record<number, number>> {
  if (pids.length === 0) return {};
  const rows = await processRows();
  const rss = new Map(rows.map((row) => [row.pid, row.rss]));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  const out: Record<number, number> = {};
  for (const pid of pids) {
    let total = 0;
    const stack = [pid];
    for (let current = stack.pop(); current != null; current = stack.pop()) {
      total += rss.get(current) ?? 0;
      stack.push(...(children.get(current) ?? []));
    }
    out[pid] = total;
  }
  return out;
}

async function processRows(): Promise<{ pid: number; parent: number; rss: number }[]> {
  const win = process.platform === "win32";
  const command = win ? "powershell" : "ps";
  const args = win
    ? [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress",
      ]
    : ["-eo", "pid=,ppid=,rss="];
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        command,
        args,
        { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, out) => (err ? reject(err) : resolve({ stdout: String(out) })),
      );
    });
    if (!win) {
      return stdout
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter((parts) => parts.length >= 3)
        .map(([pid, parent, kb]) => ({ pid, parent, rss: kb * 1024 }));
    }
    const parsed: unknown = JSON.parse(stdout || "[]");
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as {
      ProcessId: number;
      ParentProcessId: number;
      WorkingSetSize: string | number;
    }[];
    return list.map((row) => ({
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      rss: Number(row.WorkingSetSize) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * shortcut: one language-server process per pane, killed with the socket. A real
 * editor shares one server per project and multiplexes documents; upgrade when a
 * second pane on the same folder starts costing memory.
 */
export function attachTypeScriptServer(
  socket: LspSocket,
  root: string,
  /** `bundled` keeps the tsserver that ships with the language server. */
  source: "auto" | "project" | "bundled" = "auto",
  /** Folder of the file's own project, relative to `root`: the server's cwd. */
  project = "",
): void {
  // The tools are read before this call: the pane may be gone by now, and a
  // server attached to a closed socket would never be told to stop.
  if (socket.readyState != null && socket.readyState !== 1) return;
  const rootAbs = path.resolve(root);
  const cwd = path.resolve(rootAbs, project);
  // A project folder above the pane root would be a path the pane may not read.
  const inside = cwd === rootAbs || cwd.startsWith(rootAbs + path.sep);
  const dir = inside ? cwd : rootAbs;
  const tsserverPath = source === "bundled" ? null : projectTsserver(dir);
  const child = spawn(process.execPath, [tslsEntry(), "--stdio"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const id = nextId++;
  running.set(id, {
    dto: {
      id,
      root: rootAbs,
      project: dir === rootAbs ? "" : path.relative(rootAbs, dir).replaceAll("\\", "/"),
      source,
      pid: child.pid ?? 0,
      startedAt: Date.now(),
    },
    child,
    socket,
  });

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const match = /content-length:\s*(\d+)/i.exec(buf.slice(0, sep));
      const length = match ? Number(match[1]) : 0;
      const start = sep + 4;
      if (!length || buf.length < start + length) return;
      const body = buf.slice(start, start + length);
      buf = buf.slice(start + length);
      try {
        socket.send(body);
      } catch {
        stopServer(child);
        return;
      }
    }
  });
  // tsserver logs progress on stderr; relaying it would only pollute the pane.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Why a definition came back empty is otherwise a guess: `ACPIO_LSP_DEBUG=1`
    // puts the server's own complaints into the terminal.
    if (process.env.ACPIO_LSP_DEBUG) console.error("[lsp]", chunk.trim().slice(0, 500));
  });

  child.on("exit", () => {
    running.delete(id);
    try {
      socket.close();
    } catch {
      // already gone
    }
  });

  socket.on("message", (raw) => {
    if (child.killed || !child.stdin.writable) return;
    let json = String(raw);
    const patched = tsserverPath ? injectTsserver(json, tsserverPath) : null;
    if (patched) json = patched;
    child.stdin.write(frame(json));
  });
  socket.on("close", () => {
    running.delete(id);
    stopServer(child);
  });
}
