import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AppSettings, DiagnosticsDumpDto, DiagnosticsDumpMeta } from "@acprocess/shared";
import { REPO_ROOT } from "../db/client.js";
import { getSettings } from "./settings.js";

const DUMP_PREFIX = "acprocess-dump-";
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
    anthropicApiKey,
    openaiApiKey,
    ...rest
  } = settings;
  return {
    ...rest,
    cursorApiKey: cursorApiKey ? "[set]" : "",
    anthropicApiKey: anthropicApiKey ? "[set]" : "",
    openaiApiKey: openaiApiKey ? "[set]" : "",
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
      const reasonMatch = id.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/);
      items.push({
        id,
        fileName: name,
        reason: reasonMatch?.[1]?.replace(/-/g, " ") || "dump",
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
      typeof payload.reason === "string"
        ? payload.reason
        : id.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/)?.[1] || "dump";
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
