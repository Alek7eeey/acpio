import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterTranscriptClient, SubagentTranscriptPage } from "@acpio/shared";

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
export async function findCursorAgentTranscript(
  cwd: string | undefined,
  agentId: string,
): Promise<string | null> {
  const id = agentId.trim();
  if (!id) return null;
  const root = projectsRoot();
  try {
    await fs.stat(root);
  } catch {
    return null;
  }

  const tryPath = async (slug: string): Promise<string | null> => {
    const file = path.join(root, slug, "agent-transcripts", id, `${id}.jsonl`);
    try {
      await fs.stat(file);
      return file;
    } catch {
      return null;
    }
  };

  for (const slug of cwd ? cursorProjectSlugs(cwd) : []) {
    const hit = await tryPath(slug);
    if (hit) return hit;
  }

  try {
    for (const ent of await fs.readdir(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const hit = await tryPath(ent.name);
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
export async function findRecentCursorAgentIds(opts: {
  cwd?: string;
  prompt?: string;
  description?: string;
  newerThanMs?: number;
  limit?: number;
  exclude?: Iterable<string>;
}): Promise<string[]> {
  const root = projectsRoot();
  try {
    await fs.stat(root);
  } catch {
    return [];
  }
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
    try {
      await fs.stat(d);
      dirs.push(d);
    } catch {
      /* not present */
    }
  }
  if (!dirs.length) {
    try {
      for (const ent of await fs.readdir(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        const d = path.join(root, ent.name, "agent-transcripts");
        try {
          await fs.stat(d);
          dirs.push(d);
        } catch {
          /* not present */
        }
      }
    } catch {
      return [];
    }
  }

  type Hit = { id: string; mtime: number; score: number };
  const hits: Hit[] = [];
  for (const dir of dirs) {
    let ents: Dirent[];
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates = ents.filter((ent) => ent.isDirectory() && !excluded.has(ent.name));
    // Chunk the per-file stat/head pass: thousands of concurrent syscalls would
    // exhaust the libuv threadpool without improving latency here.
    for (let i = 0; i < candidates.length; i += 32) {
      const batch = await Promise.all(
        candidates.slice(i, i + 32).map(async (ent): Promise<Hit | null> => {
          const id = ent.name;
          const file = path.join(dir, id, `${id}.jsonl`);
          const st = await fs.stat(file).catch(() => null);
          if (!st || st.mtimeMs < newerThan) return null;
          let score = 1;
          if (needles.length) {
            try {
              const head = (await fs.readFile(file, "utf8")).slice(0, 4000).toLowerCase();
              score = needles.some((n) => head.includes(n)) ? 10 : 0;
            } catch {
              score = 0;
            }
          }
          return score > 0 ? { id, mtime: st.mtimeMs, score } : null;
        }),
      );
      for (const hit of batch) {
        if (hit) hits.push(hit);
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return hits.slice(0, limit).map((h) => h.id);
}

export async function findRecentCursorAgentId(opts: {
  cwd?: string;
  prompt?: string;
  description?: string;
  newerThanMs?: number;
}): Promise<string | null> {
  return (await findRecentCursorAgentIds({ ...opts, limit: 1 }))[0] ?? null;
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
  const file = await findCursorAgentTranscript(client.cwd, agentId);
  if (!file) {
    return { fromByte, nextByte: fromByte, messages: [] };
  }

  const stat = await fs.stat(file);
  const size = stat.size;
  if (size <= fromByte) {
    return { fromByte, nextByte: fromByte, messages: [] };
  }

  const handle = await fs.open(file, "r");
  try {
    const length = size - fromByte;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, fromByte);
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
    await handle.close();
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
  if (!cwd.trim()) return false;
  const a = normCwd(cwd).toLowerCase();
  return a === filter;
}

async function storeBytes(storePath: string): Promise<number> {
  try {
    return (await fs.stat(storePath)).size;
  } catch {
    return 0;
  }
}

/**
 * Cursor ACP sessions on disk (`~/.cursor/acp-sessions/<id>/`).
 * Empty probe folders (no title and tiny/missing store.db) are skipped.
 */
export async function listCursorAcpSessions(opts?: {
  root?: string;
  chatsRoot?: string;
  cwd?: string;
  excludeIds?: Iterable<string>;
  limit?: number;
}): Promise<CursorAcpSessionInfo[]> {
  const exclude = new Set([...(opts?.excludeIds ?? [])].map((s) => s.trim()).filter(Boolean));
  const cwdFilter = opts?.cwd ? normCwd(opts.cwd).toLowerCase() : "";
  const limit = opts?.limit ?? 24;
  const hits: Array<CursorAcpSessionInfo & { mtime: number; prefer: number }> = [];

  const acpRoot = opts?.root ?? path.join(os.homedir(), ".cursor", "acp-sessions");
  let ents: Dirent[] = [];
  try {
    ents = await fs.readdir(acpRoot, { withFileTypes: true });
  } catch {
    /* missing or unreadable root */
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
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as {
        cwd?: unknown;
        title?: unknown;
      };
      cwd = typeof meta.cwd === "string" ? meta.cwd : "";
      title = typeof meta.title === "string" ? meta.title.trim() : "";
    } catch {
      /* missing or invalid meta */
    }
    const size = await storeBytes(storePath);
    // Probes from this app leave an empty store.db and no title.
    if (!title && size < 4096) continue;
    if (cwdFilter && !cwdRelated(cwd, cwdFilter)) continue;
    let mtime = 0;
    try {
      mtime = (await fs.stat(size ? storePath : dir)).mtimeMs;
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

  const chatsRoot = opts?.chatsRoot ?? path.join(os.homedir(), ".cursor", "chats");
  let hashes: Dirent[] = [];
  try {
    hashes = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    /* missing or unreadable root */
  }
  for (const hashEnt of hashes) {
    if (!hashEnt.isDirectory()) continue;
    const hashDir = path.join(chatsRoot, hashEnt.name);
    let ids: Dirent[];
    try {
      ids = await fs.readdir(hashDir, { withFileTypes: true });
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
      let cwd = "";
      let title = "";
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as {
          cwd?: unknown;
          title?: unknown;
          name?: unknown;
        };
        cwd = typeof meta.cwd === "string" ? meta.cwd : "";
        title = String(meta.title ?? meta.name ?? "").trim();
      } catch {
        continue;
      }
      const size = await storeBytes(storePath);
      if (!title && size < 4096) continue;
      if (cwdFilter && !cwdRelated(cwd, cwdFilter)) continue;
      let mtime = 0;
      try {
        mtime = (await fs.stat(size ? storePath : dir)).mtimeMs;
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
