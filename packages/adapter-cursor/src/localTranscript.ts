import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterTranscriptClient, SubagentTranscriptPage } from "@acprocess/shared";

const REDACTED = /^\[REDACTED\]$/i;

/** Candidate Cursor project folder names for a workspace cwd. */
export function cursorProjectSlugs(cwd: string): string[] {
  const resolved = path.resolve(cwd.trim() || ".");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!match) {
    const slug = resolved.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "-");
    return slug ? [slug, slug.toLowerCase()] : [];
  }
  const drive = match[1];
  const rest = match[2].replace(/[\\/]+/g, "-");
  const mixed = `${drive}-${rest}`;
  const lowerDrive = `${drive.toLowerCase()}-${rest}`;
  const lowerAll = `${drive.toLowerCase()}-${rest.toLowerCase()}`;
  return [...new Set([mixed, lowerDrive, lowerAll, mixed.toLowerCase()])];
}

function projectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

/** Locate `agent-transcripts/<id>/<id>.jsonl` for a Cursor subagent. */
export function findCursorAgentTranscript(cwd: string | undefined, agentId: string): string | null {
  const id = agentId.trim();
  if (!id) return null;
  const root = projectsRoot();
  if (!fs.existsSync(root)) return null;

  const tryPath = (slug: string): string | null => {
    const file = path.join(root, slug, "agent-transcripts", id, `${id}.jsonl`);
    return fs.existsSync(file) ? file : null;
  };

  for (const slug of cwd ? cursorProjectSlugs(cwd) : []) {
    const hit = tryPath(slug);
    if (hit) return hit;
  }

  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const hit = tryPath(ent.name);
      if (hit) return hit;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * When Cursor ACP has not yet exposed agentId, find freshly written transcripts.
 * Returns newest-first ids (optionally filtered by prompt/description match).
 */
export function findRecentCursorAgentIds(opts: {
  cwd?: string;
  prompt?: string;
  description?: string;
  newerThanMs?: number;
  limit?: number;
  exclude?: Iterable<string>;
}): string[] {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const newerThan = opts.newerThanMs ?? Date.now() - 15 * 60_000;
  const limit = opts.limit ?? 8;
  const excluded = new Set([...(opts.exclude ?? [])].map((s) => s.trim()).filter(Boolean));
  const needles = [opts.prompt, opts.description]
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length >= 8)
    .map((s) => s.slice(0, 120).toLowerCase());

  const slugs = opts.cwd ? cursorProjectSlugs(opts.cwd) : [];
  const dirs: string[] = [];
  for (const slug of slugs) {
    const d = path.join(root, slug, "agent-transcripts");
    if (fs.existsSync(d)) dirs.push(d);
  }
  if (!dirs.length) {
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const d = path.join(root, ent.name, "agent-transcripts");
        if (fs.existsSync(d)) dirs.push(d);
      }
    } catch {
      return [];
    }
  }

  type Hit = { id: string; mtime: number; score: number };
  const hits: Hit[] = [];
  for (const dir of dirs) {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (excluded.has(id)) continue;
      const file = path.join(dir, id, `${id}.jsonl`);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < newerThan) continue;
      let score = 1;
      if (needles.length) {
        try {
          const head = fs.readFileSync(file, { encoding: "utf8" }).slice(0, 4000).toLowerCase();
          score = needles.some((n) => head.includes(n)) ? 10 : 0;
        } catch {
          score = 0;
        }
      }
      if (score > 0) hits.push({ id, mtime: st.mtimeMs, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return hits.slice(0, limit).map((h) => h.id);
}

export function findRecentCursorAgentId(opts: {
  cwd?: string;
  prompt?: string;
  description?: string;
  newerThanMs?: number;
}): string | null {
  return findRecentCursorAgentIds({ ...opts, limit: 1 })[0] ?? null;
}

function thinkingBlock(text: string): { type: "thinking"; thinking: string } | null {
  const value = text.trim();
  if (!value || REDACTED.test(value)) return null;
  return { type: "thinking", thinking: value };
}

/** Turn one Cursor agent-transcript JSONL line into assistant thinking/tool blocks. */
function blocksFromTranscriptLine(line: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const row = parsed as {
    role?: string;
    type?: string;
    message?: { content?: unknown };
  };
  if (row.type === "turn_ended") return out;
  if (row.role !== "assistant" && row.role !== "user") return out;
  const content = row.message?.content;
  if (!Array.isArray(content)) return out;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const type = String(block.type ?? "");
    if (row.role === "user" && type === "text") {
      // Skip the launch prompt — not card body.
      continue;
    }
    if (type === "thinking" || type === "reasoning") {
      const t = thinkingBlock(String(block.thinking ?? block.reasoning ?? block.text ?? ""));
      if (t) out.push(t);
      continue;
    }
    if (type === "text") {
      const t = thinkingBlock(String(block.text ?? ""));
      if (t) out.push(t);
      continue;
    }
    if (type === "tool_use" || type === "tool-call") {
      const name = String(block.name ?? "tool").trim() || "tool";
      const input = (block.input ?? {}) as Record<string, unknown>;
      const detail = String(
        input.description ?? input.command ?? input.path ?? input.query ?? "",
      ).trim();
      out.push({
        type: "tool_use",
        name,
        ...(detail ? { args: detail.slice(0, 200) } : {}),
        thinking: detail ? `${name}: ${detail}` : name,
      });
    }
  }
  return out;
}

/**
 * Incremental read of a Cursor subagent transcript on disk.
 * ACP does not stream Task progress; Cursor writes live JSONL under projects/.
 */
export async function readCursorAgentTranscript(
  client: AdapterTranscriptClient,
  agentId: string,
  fromByte: number,
): Promise<SubagentTranscriptPage | undefined> {
  const file = findCursorAgentTranscript(client.cwd, agentId);
  if (!file) {
    return { fromByte, nextByte: fromByte, messages: [] };
  }

  const stat = fs.statSync(file);
  const size = stat.size;
  if (size <= fromByte) {
    return { fromByte, nextByte: fromByte, messages: [] };
  }

  const fd = fs.openSync(file, "r");
  try {
    const length = size - fromByte;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fromByte);
    const chunk = buf.toString("utf8");
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) {
      return { fromByte, nextByte: fromByte, messages: [] };
    }
    const complete = chunk.slice(0, lastNl + 1);
    const nextByte = fromByte + Buffer.byteLength(complete, "utf8");
    const content: Array<Record<string, unknown>> = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      content.push(...blocksFromTranscriptLine(line));
    }
    return {
      fromByte,
      nextByte,
      messages: content.length ? [{ role: "assistant", content }] : [],
    };
  } finally {
    fs.closeSync(fd);
  }
}

export type CursorAcpSessionInfo = {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
};

function normCwd(cwd: string): string {
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function cwdRelated(cwd: string, filter: string): boolean {
  if (!filter) return true;
  if (!cwd.trim()) return true;
  const a = normCwd(cwd).toLowerCase();
  const b = filter;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function storeBytes(storePath: string): number {
  try {
    return fs.statSync(storePath).size;
  } catch {
    return 0;
  }
}

/**
 * Cursor ACP sessions on disk (`~/.cursor/acp-sessions/<id>/`).
 * Empty probe folders (no title and tiny/missing store.db) are skipped.
 */
export function listCursorAcpSessions(opts?: {
  root?: string;
  chatsRoot?: string;
  cwd?: string;
  excludeIds?: Iterable<string>;
  limit?: number;
}): CursorAcpSessionInfo[] {
  const exclude = new Set([...(opts?.excludeIds ?? [])].map((s) => s.trim()).filter(Boolean));
  const cwdFilter = opts?.cwd ? normCwd(opts.cwd).toLowerCase() : "";
  const limit = opts?.limit ?? 24;
  const hits: Array<CursorAcpSessionInfo & { mtime: number; prefer: number }> = [];

  const acpRoot = opts?.root ?? path.join(os.homedir(), ".cursor", "acp-sessions");
  if (fs.existsSync(acpRoot)) {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(acpRoot, { withFileTypes: true });
    } catch {
      ents = [];
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const sessionId = ent.name.trim();
      if (!sessionId || exclude.has(sessionId)) continue;
      const dir = path.join(acpRoot, sessionId);
      const metaPath = path.join(dir, "meta.json");
      const storePath = path.join(dir, "store.db");
      let cwd = "";
      let title = "";
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { cwd?: unknown; title?: unknown };
        cwd = typeof meta.cwd === "string" ? meta.cwd : "";
        title = typeof meta.title === "string" ? meta.title.trim() : "";
      } catch {
        /* missing or invalid meta */
      }
      const size = storeBytes(storePath);
      // Probes from this app leave an empty store.db and no title.
      if (!title && size < 4096) continue;
      if (cwdFilter && cwd && !cwdRelated(cwd, cwdFilter)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(size ? storePath : dir).mtimeMs;
      } catch {
        continue;
      }
      hits.push({
        sessionId,
        cwd,
        title,
        updatedAt: new Date(mtime).toISOString(),
        mtime,
        prefer: cwdFilter && cwd && cwdRelated(cwd, cwdFilter) ? 1 : 0,
      });
    }
  }

  const chatsRoot = opts?.chatsRoot ?? path.join(os.homedir(), ".cursor", "chats");
  if (fs.existsSync(chatsRoot)) {
    let hashes: fs.Dirent[];
    try {
      hashes = fs.readdirSync(chatsRoot, { withFileTypes: true });
    } catch {
      hashes = [];
    }
    for (const hashEnt of hashes) {
      if (!hashEnt.isDirectory()) continue;
      const hashDir = path.join(chatsRoot, hashEnt.name);
      let ids: fs.Dirent[];
      try {
        ids = fs.readdirSync(hashDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const idEnt of ids) {
        if (!idEnt.isDirectory()) continue;
        const sessionId = idEnt.name.trim();
        if (!sessionId || exclude.has(sessionId)) continue;
        const dir = path.join(hashDir, sessionId);
        const metaPath = path.join(dir, "meta.json");
        const storePath = path.join(dir, "store.db");
        if (!fs.existsSync(metaPath)) continue;
        let cwd = "";
        let title = "";
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            cwd?: unknown;
            title?: unknown;
            name?: unknown;
          };
          cwd = typeof meta.cwd === "string" ? meta.cwd : "";
          title = String(meta.title ?? meta.name ?? "").trim();
        } catch {
          continue;
        }
        const size = storeBytes(storePath);
        if (!title && size < 4096) continue;
        if (cwdFilter && cwd && !cwdRelated(cwd, cwdFilter)) continue;
        let mtime = 0;
        try {
          mtime = fs.statSync(size ? storePath : dir).mtimeMs;
        } catch {
          continue;
        }
        hits.push({
          sessionId,
          cwd,
          title,
          updatedAt: new Date(mtime).toISOString(),
          mtime,
          prefer: cwdFilter && cwd && cwdRelated(cwd, cwdFilter) ? 1 : 0,
        });
      }
    }
  }

  hits.sort((a, b) => b.prefer - a.prefer || b.mtime - a.mtime);
  const seen = new Set<string>();
  const out: CursorAcpSessionInfo[] = [];
  for (const hit of hits) {
    if (seen.has(hit.sessionId)) continue;
    seen.add(hit.sessionId);
    out.push({
      sessionId: hit.sessionId,
      cwd: hit.cwd,
      title: hit.title,
      updatedAt: hit.updatedAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}
