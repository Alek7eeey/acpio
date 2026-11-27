import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AppSettings, DiagnosticsDumpDto, DiagnosticsDumpMeta } from "@acpio/shared";
import { REPO_ROOT } from "../db/client.js";
import { getSettings } from "./settings.js";

const DUMP_PREFIX = "acpio-dump-";
const DUMP_EXT = ".json";

function assertInsideDir(dir: string, filePath: string) {
  const root = path.resolve(dir);
  const resolved = path.resolve(filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function defaultDiagnosticsDir(): string {
  return path.join(REPO_ROOT, "diagnostics");
}

export async function resolveDiagnosticsDir(settings?: AppSettings): Promise<string> {
  const cfg = settings ?? (await getSettings());
  const raw = (cfg.diagnosticsDir || "").trim();
  if (!raw) return defaultDiagnosticsDir();
  return path.resolve(raw);
}

function redactSettings(settings: AppSettings): Record<string, unknown> {
  const {
    cursorApiKey,
    adapterEnv,
    builtinProviders,
    ...rest
  } = settings;
  return {
    ...rest,
    cursorApiKey: cursorApiKey ? "[set]" : "",
    // A harness's env carries its key under whatever name that CLI uses: the
    // dump keeps the names, never the values.
    adapterEnv: Object.fromEntries(
      Object.entries(adapterEnv ?? {}).map(([id, env]) => [
        id,
        Object.fromEntries(Object.keys(env).map((name) => [name, "[set]"])),
      ]),
    ),
    // Every provider keeps its row (id/name/models matter for support) but
    // never its key; a header value is a credential as often as not.
    builtinProviders: builtinProviders.map((p) => ({
      ...p,
      // Every key of the pool, masked one by one — a dump says whether a key is
      // configured, never what it is.
      apiKeys: (p.apiKeys ?? []).map((key) => (key ? "[set]" : "")),
      ...(p.apiKey === undefined ? {} : { apiKey: p.apiKey ? "[set]" : "" }),
      ...(p.headers?.length
        ? {
            headers: p.headers.map((h) => ({ name: h.name, value: h.value ? "[set]" : "" })),
          }
        : {}),
    })),
  };
}

function safeFileStamp(iso: string) {
  return iso.replace(/[:.]/g, "-");
}

function isDumpFileName(name: string) {
  return name.startsWith(DUMP_PREFIX) && name.endsWith(DUMP_EXT);
}

function idFromFileName(fileName: string) {
  return fileName.slice(DUMP_PREFIX.length, -DUMP_EXT.length);
}

/**
 * Why a dump was taken, as its id carries it: `…T12-39-22-031Z_error`. The `Z`
 * ends the stamp, so the reason starts after it — without the optional `Z` the
 * match failed on every id and each dump read as "dump", hiding the crashes.
 */
function reasonFromId(id: string): string | null {
  return id.match(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_(.+)$/)?.[1]?.replace(/-/g, " ") ?? null;
}

function fileNameFromId(id: string) {
  const clean = id.replace(/[^a-zA-Z0-9._-]/g, "");
  return `${DUMP_PREFIX}${clean}${DUMP_EXT}`;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeDiagnosticsDump(input: {
  reason?: string;
  note?: string;
  client?: Record<string, unknown>;
}): Promise<DiagnosticsDumpMeta> {
  const settings = await getSettings();
  const dir = await resolveDiagnosticsDir(settings);
  await ensureDir(dir);

  const createdAt = new Date().toISOString();
  const reason = (input.reason || "manual").trim().slice(0, 80) || "manual";
  const id = `${safeFileStamp(createdAt)}_${reason.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40)}`;
  const fileName = fileNameFromId(id);
  const filePath = path.join(dir, fileName);

  const payload = {
    version: 1,
    reason,
    note: input.note?.trim() || undefined,
    createdAt,
    client: input.client ?? {},
    server: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      cwd: process.cwd(),
      repoRoot: REPO_ROOT,
      hostname: os.hostname(),
      uptimeSec: Math.round(process.uptime()),
      diagnosticsDir: dir,
      settings: redactSettings(settings),
      memory: {
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed,
      },
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "",
        hasDatabasePath: Boolean(process.env.DATABASE_PATH),
      },
    },
  };

  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(filePath, body, "utf8");
  const stat = await fs.stat(filePath);

  return {
    id,
    fileName,
    reason,
    createdAt,
    size: stat.size,
    path: filePath,
  };
}

export async function listDiagnosticsDumps(): Promise<{
  dir: string;
  defaultDir: string;
  items: DiagnosticsDumpMeta[];
}> {
  const settings = await getSettings();
  const dir = await resolveDiagnosticsDir(settings);
  const defaultDir = defaultDiagnosticsDir();
  await ensureDir(dir);

  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }

  const items: DiagnosticsDumpMeta[] = [];
  for (const name of names) {
    if (!isDumpFileName(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const id = idFromFileName(name);
      items.push({
        id,
        fileName: name,
        reason: reasonFromId(id) || "dump",
        createdAt: new Date(stat.mtimeMs).toISOString(),
        size: stat.size,
        path: filePath,
      });
    } catch {
      // skip unreadable
    }
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fileName.localeCompare(a.fileName));
  return { dir, defaultDir, items };
}

export async function readDiagnosticsDump(id: string): Promise<DiagnosticsDumpDto | null> {
  const settings = await getSettings();
  const dir = await resolveDiagnosticsDir(settings);
  const fileName = fileNameFromId(id);
  const filePath = path.join(dir, fileName);
  if (!assertInsideDir(dir, filePath)) return null;

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const stat = await fs.stat(filePath);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = { raw };
    }
    const reason =
      typeof payload.reason === "string" ? payload.reason : reasonFromId(id) || "dump";
    const createdAt =
      typeof payload.createdAt === "string" ? payload.createdAt : new Date(stat.mtimeMs).toISOString();
    return {
      id,
      fileName,
      reason,
      createdAt,
      size: stat.size,
      path: filePath,
      payload,
    };
  } catch {
    return null;
  }
}

/**
 * A dump's bytes as they sit on disk, for the button that hands one dump over
 * as a file: the same name the row shows, nothing re-serialized.
 */
export async function readDiagnosticsDumpFile(
  id: string,
): Promise<{ fileName: string; body: string } | null> {
  const settings = await getSettings();
  const dir = await resolveDiagnosticsDir(settings);
  const fileName = fileNameFromId(id);
  const filePath = path.join(dir, fileName);
  if (!assertInsideDir(dir, filePath)) return null;
  try {
    return { fileName, body: await fs.readFile(filePath, "utf8") };
  } catch {
    return null;
  }
}

export async function deleteDiagnosticsDump(id: string): Promise<boolean> {
  const settings = await getSettings();
  const dir = await resolveDiagnosticsDir(settings);
  const fileName = fileNameFromId(id);
  const filePath = path.join(dir, fileName);
  if (!assertInsideDir(dir, filePath)) return false;
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
