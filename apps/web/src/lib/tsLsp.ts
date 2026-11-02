import type { LintItem } from "./editorApi";

/**
 * A deliberately small LSP client: one WebSocket, one document at a time, full
 * text sync. That is enough for definition, references and diagnostics, and it
 * keeps the pane in control of every message it sends.
 *
 * shortcut: full-text sync on every change, no incremental changes and no
 * completion. Upgrade to incremental sync when a large file starts lagging.
 */

export type LspPosition = { line: number; character: number };
export type LspLocation = { uri: string; line: number; col: number };

type RpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: Record<string, unknown>;
};

export function pathToUri(abs: string): string {
  const posix = abs.replace(/\\/g, "/").replace(/^\/+/, "");
  const encoded = posix.replace(/[^A-Za-z0-9/._~!$&'()*+,;=:@-]/g, (c) => encodeURIComponent(c));
  return `file:///${encoded}`;
}

/** `file:///c%3A/folder/x.ts` → `folder/x.ts`, relative to the pane root. */
export function uriToRelPath(root: string, uri: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
  } catch {
    return null;
  }
  const abs = decoded.replace(/\//g, "\\");
  const base = root.replace(/\//g, "\\").replace(/\\$/, "");
  const lowerAbs = abs.toLowerCase();
  const lowerBase = base.toLowerCase();
  if (lowerAbs === lowerBase) return "";
  if (!lowerAbs.startsWith(lowerBase + "\\")) return null;
  return abs.slice(base.length + 1).replace(/\\/g, "/");
}

type DiagnosticParams = {
  uri: string;
  diagnostics: Array<{
    message: string;
    severity?: number;
    range: { start: LspPosition; end: LspPosition };
  }>;
};

export class TsLsp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, number>();
  private root: string;
  /** Sent before the handshake ends — order matters, so they wait here. */
  private outbox: string[] = [];
  /** False until `initialize` was answered: nothing may precede it. */
  private live = false;

  /** Pushed by the server whenever tsserver re-analyses a file. */
  onDiagnostics: ((relPath: string, items: LintItem[]) => void) | null = null;
  ready: Promise<void>;

  /** `project` is the file's own project folder, relative to the pane root. */
  constructor(root: string, project = "") {
    this.root = root;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(
      `${proto}://${window.location.host}/ws/editor/lsp?root=${encodeURIComponent(root)}` +
        `&project=${encodeURIComponent(project)}`,
    );
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        // A `didOpen` that overtakes `initialize` leaves the file in an inferred
        // project, where tsserver resolves no imports at all.
        void this.handshake().then(() => {
          this.live = true;
          for (const json of this.outbox.splice(0)) this.ws.send(json);
          resolve();
        }, reject);
      });
      this.ws.addEventListener("error", () => reject(new Error("language server socket failed")));
    });
    this.ws.addEventListener("message", (ev) => this.receive(String(ev.data)));
  }

  private send(msg: unknown): void {
    const json = JSON.stringify(msg);
    // A file opened before the handshake ends must not throw: hold it here.
    if (!this.live || this.ws.readyState === WebSocket.CONNECTING) {
      this.outbox.push(json);
      return;
    }
    this.ws.send(json);
  }

  /** Inside the handshake, where `send` would queue what must go out now. */
  private raw(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async handshake(): Promise<void> {
    const rootUri = pathToUri(this.root);
    const id = this.nextId++;
    const answered = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
    });
    this.raw({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        processId: null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          // Without the workspace capabilities the server ignores
          // `workspaceFolders`, loads no tsconfig, and every document lands in
          // an inferred project where only opened files resolve.
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            definition: { linkSupport: false },
            references: {},
            publishDiagnostics: {},
          },
        },
      },
    });
    await answered;
    this.raw({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  private receive(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && msg.method) {
      // Server-initiated requests only need a yes: refusing them makes tsserver
      // drop the connection, and we ask for nothing that needs configuration.
      const result =
        msg.method === "workspace/configuration"
          ? ((msg.params?.items as unknown[]) ?? []).map(() => ({}))
          : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "language server error"));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
      const params = msg.params as unknown as DiagnosticParams;
      const rel = uriToRelPath(this.root, params.uri);
      if (!rel || !this.onDiagnostics) return;
      this.onDiagnostics(
        rel,
        params.diagnostics.map((d) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endCol: d.range.end.character + 1,
          message: d.message,
          severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
          source: "ts",
        })),
      );
    }
  }

  open(path: string, text: string): void {
    // The server speaks TypeScript: a YAML or CSS document it never saw is
    // better off without the hundreds of syntax errors it would answer with.
    const languageId = languageIdOf(path);
    if (!languageId) return;
    const uri = pathToUri(`${this.root}\\${path}`);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  change(path: string, text: string): void {
    const uri = pathToUri(`${this.root}\\${path}`);
    if (!this.versions.has(uri)) return this.open(path, text);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  close(path: string): void {
    const uri = pathToUri(`${this.root}\\${path}`);
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async definition(path: string, line: number, character: number): Promise<LspLocation[]> {
    const res = await this.request<unknown>("textDocument/definition", {
      textDocument: { uri: pathToUri(`${this.root}\\${path}`) },
      position: { line, character },
    });
    return toLocations(res);
  }

  async references(path: string, line: number, character: number): Promise<LspLocation[]> {
    const res = await this.request<unknown>("textDocument/references", {
      textDocument: { uri: pathToUri(`${this.root}\\${path}`) },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return toLocations(res);
  }

  dispose(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

function toLocations(res: unknown): LspLocation[] {
  const list = Array.isArray(res) ? res : res ? [res] : [];
  return list.flatMap((item) => {
    const loc = item as { uri?: string; targetUri?: string; range?: { start: LspPosition } };
    const uri = loc.targetUri ?? loc.uri;
    if (!uri || !loc.range) return [];
    return [{ uri, line: loc.range.start.line + 1, col: loc.range.start.character + 1 }];
  });
}

/** `null` for a file the TypeScript server has no business parsing. */
function languageIdOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "mts" || ext === "cts") return "typescript";
  if (ext === "tsx") return "typescriptreact";
  if (ext === "js" || ext === "cjs" || ext === "mjs") return "javascript";
  if (ext === "jsx") return "javascriptreact";
  if (ext === "json") return "json";
  return null;
}
