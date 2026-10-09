import fs from "node:fs/promises";
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
  if (!cwd.trim()) return false;
  return normCwd(cwd) === filter;
}

// Fixed-size IO waves: enough parallelism to stay near the old sync latency, few
// enough concurrent handles for a cold scan over the 20_000-file budget.
const IO_BATCH = 32;

/** Map `items` in `IO_BATCH`-sized waves, preserving input order in the result. */
async function mapInBatches<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += IO_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + IO_BATCH).map((item) => worker(item)))));
  }
  return out;
}

/** `mtimeMs`, or null when the file vanished after the scan — callers skip those rows. */
async function statMtime(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function collectJsonlFiles(dir: string, out: string[], budget: number): Promise<void> {
  if (out.length >= budget) return;
  // A missing or unreadable folder is not an error here: it just contributes no sessions.
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of ents) {
    if (out.length >= budget) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isEphemeralOmpDir(ent.name)) continue;
      // Sequential: parallel descent would reorder `out`, which decides mtime ties below.
      await collectJsonlFiles(full, out, budget);
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

async function readHead(filePath: string, bytes = 8_192): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Native OMP sessions on disk under ~/.omp/agent/sessions. */
export async function listOmpSessions(opts?: {
  root?: string;
  cwd?: string;
  excludeIds?: Iterable<string>;
  limit?: number;
}): Promise<OmpSessionInfo[]> {
  const root = ompSessionsRoot(opts?.root);
  const exclude = new Set([...(opts?.excludeIds ?? [])].map((s) => s.trim()).filter(Boolean));
  const cwdFilter = opts?.cwd ? normCwd(opts.cwd) : "";
  const limit = opts?.limit ?? 24;
  const files: string[] = [];
  // A missing root yields no files, so it lists nothing — same as the old existsSync guard.
  await collectJsonlFiles(root, files, 20_000);

  type FileHit = { file: string; sessionId: string; mtime: number };
  const candidates = files.filter((file) => {
    const fromName = fileSessionId(file);
    return Boolean(fromName) && !exclude.has(fromName);
  });
  // Stat in waves, then rank in scan order so equal mtimes still keep the first hit.
  const mtimes = await mapInBatches(candidates, statMtime);
  const newestById = new Map<string, FileHit>();
  for (let i = 0; i < candidates.length; i++) {
    const mtime = mtimes[i];
    if (mtime == null) continue;
    const file = candidates[i]!;
    const sessionId = fileSessionId(file);
    const prev = newestById.get(sessionId);
    if (prev && prev.mtime >= mtime) continue;
    newestById.set(sessionId, { file, sessionId, mtime });
  }

  const ranked = [...newestById.values()].sort((a, b) => b.mtime - a.mtime);
  const hits: Array<OmpSessionInfo & { prefer: number }> = [];
  const scanCap = Math.max(limit * 5, 80);
  // Heads are read one wave at a time; the scanCap check inside the wave keeps the read
  // volume within one batch of what the old one-file-at-a-time loop touched.
  for (let start = 0; start < ranked.length && hits.length < scanCap; start += IO_BATCH) {
    const batch = ranked.slice(start, start + IO_BATCH);
    const heads = await Promise.all(
      batch.map(async (row) => {
        try {
          return await readHead(row.file, 24_576);
        } catch {
          /* filename is enough to list */
          return "";
        }
      }),
    );
    for (let i = 0; i < batch.length; i++) {
      if (hits.length >= scanCap) break;
      const row = batch[i]!;
      const head = heads[i] ?? "";
      const header = parseHeader(head);
      let sessionId = row.sessionId;
      if (header.sessionId) sessionId = header.sessionId;
      const cwd = header.cwd;
      const title = header.title;
      if (exclude.has(sessionId)) continue;
      if (cwdFilter && (!cwd || !cwdRelated(cwd, cwdFilter))) continue;
      if (!/"role"\s*:\s*"user"/i.test(head) && !title) continue;
      hits.push({
        sessionId,
        cwd,
        title,
        updatedAt: new Date(row.mtime).toISOString(),
        prefer: cwdFilter && cwd && cwdRelated(cwd, cwdFilter) ? 1 : 0,
      });
    }
  }
  hits.sort((a, b) => b.prefer - a.prefer || b.updatedAt.localeCompare(a.updatedAt));
  return hits.slice(0, limit).map(({ prefer: _p, ...row }) => row);
}

export async function findOmpSessionFile(sessionId: string, root?: string): Promise<string | null> {
  const id = sessionId.trim();
  if (!id) return null;
  const base = ompSessionsRoot(root);
  const files: string[] = [];
  await collectJsonlFiles(base, files, 20_000);
  const suffix = `_${id}.jsonl`.toLowerCase();
  // The name filter is pure, so it runs before the stats: only real candidates hit the disk.
  const matches = files.filter((file) => path.basename(file).toLowerCase().endsWith(suffix));
  const mtimes = await mapInBatches(matches, statMtime);
  let best: { file: string; mtime: number } | null = null;
  for (let i = 0; i < matches.length; i++) {
    const mtime = mtimes[i];
    if (mtime == null) continue;
    if (!best || mtime > best.mtime) best = { file: matches[i]!, mtime };
  }
  return best?.file ?? null;
}

/** User/assistant turns from an OMP jsonl (tools omitted). */
export async function readOmpSessionTranscript(
  sessionId: string,
  opts?: { root?: string; maxTurns?: number },
): Promise<OmpSessionTranscript | null> {
  const filePath = await findOmpSessionFile(sessionId, opts?.root);
  if (!filePath) return null;
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const header = parseHeader(raw.slice(0, 16_384));
  const maxTurns = opts?.maxTurns ?? 200;
  const turns: OmpTranscriptTurn[] = [];
  const mtime = await statMtime(filePath);

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
    updatedAt: mtime != null ? new Date(mtime).toISOString() : new Date().toISOString(),
    filePath,
    turns,
  };
}
