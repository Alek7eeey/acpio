import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** The bit of a WebSocket this bridge needs; keeps it testable without a server. */
export type LspSocket = {
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close", cb: () => void): unknown;
};

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
        child.kill();
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
  socket.on("close", () => child.kill());
}
