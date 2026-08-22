import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type OmpSessionInfo = {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
};

export type OmpTranscriptTurn = {
  role: "user" | "assistant";
  text: string;
  thought?: string;
};

export type OmpSessionTranscript = OmpSessionInfo & {
  filePath: string;
  turns: OmpTranscriptTurn[];
};

const ID_FROM_NAME = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function ompSessionsRoot(root?: string): string {
  return root ?? path.join(os.homedir(), ".omp", "agent", "sessions");
}

function normCwd(cwd: string): string {
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function extractText(content: unknown): { text: string; thought: string } {
  let text = "";
  let thought = "";
  if (typeof content === "string") {
    const value = content.trim();
    return { text: value, thought };
  }
  if (!Array.isArray(content)) return { text, thought };
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const type = String(block.type ?? "");
    if (type === "text") {
      const value = String(block.text ?? "").trim();
      if (value) text = text ? `${text}\n\n${value}` : value;
    } else if (type === "thinking" || type === "reasoning") {
      const value = String(block.thinking ?? block.reasoning ?? block.text ?? "").trim();
      if (value) thought = thought ? `${thought}\n\n${value}` : value;
    }
  }
  return { text, thought };
}

function parseHeader(rawHead: string): { sessionId: string; cwd: string; title: string } {
  let sessionId = "";
  let cwd = "";
  let title = "";
  for (const line of rawHead.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const row = parsed as Record<string, unknown>;
    const type = String(row.type ?? "");
    if (type === "session") {
      if (typeof row.id === "string") sessionId = row.id.trim();
      if (typeof row.cwd === "string") cwd = row.cwd;
      if (typeof row.title === "string" && row.title.trim()) title = row.title.trim();
    } else if ((type === "title" || type === "title_change") && typeof row.title === "string" && row.title.trim()) {
      title = row.title.trim();
    }
  }
  return { sessionId, cwd, title };
}

function isEphemeralOmpDir(name: string): boolean {
  const n = name.toLowerCase();
  return /omp-acp-probe|omp-acp-e2e|omp-acp-prog|_temp-mcp|_temp-omp|nf-verify|nf-clean/.test(n);
}

function cwdRelated(cwd: string, filter: string): boolean {
  if (!filter) return true;
  if (!cwd.trim()) return true;
  const a = normCwd(cwd);
  const b = filter;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function collectJsonlFiles(dir: string, out: string[], budget: number): void {
  if (out.length >= budget) return;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (out.length >= budget) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isEphemeralOmpDir(ent.name)) continue;
      collectJsonlFiles(full, out, budget);
      continue;
    }
    if (ent.isFile() && ent.name.endsWith(".jsonl") && ID_FROM_NAME.test(ent.name)) {
      out.push(full);
    }
  }
}

function fileSessionId(filePath: string): string {
  const match = ID_FROM_NAME.exec(path.basename(filePath));
  return match?.[1] ?? "";
}

function readHead(filePath: string, bytes = 8_192): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Native OMP sessions on disk under ~/.omp/agent/sessions. */
export function listOmpSessions(opts?: {
  root?: string;
  cwd?: string;
  excludeIds?: Iterable<string>;
  limit?: number;
}): OmpSessionInfo[] {
  const root = ompSessionsRoot(opts?.root);
  if (!fs.existsSync(root)) return [];
  const exclude = new Set([...(opts?.excludeIds ?? [])].map((s) => s.trim()).filter(Boolean));
  const cwdFilter = opts?.cwd ? normCwd(opts.cwd) : "";
  const limit = opts?.limit ?? 24;
  const files: string[] = [];
  collectJsonlFiles(root, files, 20_000);

  type FileHit = { file: string; sessionId: string; mtime: number };
  const newestById = new Map<string, FileHit>();
  for (const file of files) {
    const fromName = fileSessionId(file);
    if (!fromName || exclude.has(fromName)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const prev = newestById.get(fromName);
    if (prev && prev.mtime >= mtime) continue;
    newestById.set(fromName, { file, sessionId: fromName, mtime });
  }

  const ranked = [...newestById.values()].sort((a, b) => b.mtime - a.mtime);
  const hits: Array<OmpSessionInfo & { prefer: number }> = [];
  const scanCap = Math.max(limit * 5, 80);
  for (const row of ranked) {
    if (hits.length >= scanCap) break;
    let cwd = "";
    let title = "";
    let sessionId = row.sessionId;
    let head = "";
    try {
      head = readHead(row.file, 24_576);
      const header = parseHeader(head);
      if (header.sessionId) sessionId = header.sessionId;
      cwd = header.cwd;
      title = header.title;
    } catch {
      /* filename is enough to list */
    }
    if (exclude.has(sessionId)) continue;
    if (!/"role"\s*:\s*"user"/i.test(head) && !title) continue;
    hits.push({
      sessionId,
      cwd,
      title,
      updatedAt: new Date(row.mtime).toISOString(),
      prefer: cwdFilter && cwd && cwdRelated(cwd, cwdFilter) ? 1 : 0,
    });
  }
  hits.sort((a, b) => b.prefer - a.prefer || b.updatedAt.localeCompare(a.updatedAt));
  return hits.slice(0, limit).map(({ prefer: _p, ...row }) => row);
}

export function findOmpSessionFile(sessionId: string, root?: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  const base = ompSessionsRoot(root);
  if (!fs.existsSync(base)) return null;
  const files: string[] = [];
  collectJsonlFiles(base, files, 20_000);
  const suffix = `_${id}.jsonl`.toLowerCase();
  let best: { file: string; mtime: number } | null = null;
  for (const file of files) {
    if (!path.basename(file).toLowerCase().endsWith(suffix)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

/** User/assistant turns from an OMP jsonl (tools omitted). */
export function readOmpSessionTranscript(
  sessionId: string,
  opts?: { root?: string; maxTurns?: number },
): OmpSessionTranscript | null {
  const filePath = findOmpSessionFile(sessionId, opts?.root);
  if (!filePath) return null;
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const header = parseHeader(raw.slice(0, 16_384));
  const maxTurns = opts?.maxTurns ?? 200;
  const turns: OmpTranscriptTurn[] = [];
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(filePath);
  } catch {
    /* ignore */
  }

  for (const line of raw.split(/\r?\n/)) {
    if (turns.length >= maxTurns) break;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const row = parsed as { type?: string; message?: { role?: string; content?: unknown } };
    if (row.type !== "message" || !row.message) continue;
    const role = row.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const extracted = extractText(row.message.content);
    if (!extracted.text && !extracted.thought) continue;
    if (role === "user") {
      if (!extracted.text) continue;
      turns.push({ role: "user", text: extracted.text.slice(0, 50_000) });
      continue;
    }
    turns.push({
      role: "assistant",
      text: extracted.text.slice(0, 80_000),
      ...(extracted.thought ? { thought: extracted.thought.slice(0, 80_000) } : {}),
    });
  }

  return {
    sessionId: header.sessionId || sessionId,
    cwd: header.cwd,
    title: header.title,
    updatedAt: st ? new Date(st.mtimeMs).toISOString() : new Date().toISOString(),
    filePath,
    turns,
  };
}
