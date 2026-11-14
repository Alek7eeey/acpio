import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { BUILD_INFO, type WireLogMode, type WireLogStatusDto } from "@acpio/shared";
import { wireLogDir } from "@acpio/adapter-builtin";

/**
 * The switch a human flips, and the archive they send back.
 *
 * The agent decides whether to record from the file `<log folder>/on` — its
 * contents are the mode — re-read every few seconds, so a toggle in Settings
 * turns recording on and off without a restart. `ACPIO_WIRE_LOG` still wins
 * over the file: a server started with it forced is reported as such instead of
 * pretending the switch works.
 */

const SWITCH_FILE = "on";
/**
 * A support bundle is read by a human on the other end — keep it sendable, and
 * keep the archive build inside one process's memory (the whole folder is read
 * and deflated at once). Bodies are megabytes each, so `full` on a long chat
 * reaches this ceiling; the error says which knob to turn.
 */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export function wireLogSwitchPath(): string {
  return path.join(wireLogDir(), SWITCH_FILE);
}

/** The mode the switch file alone says; `off` when it is missing or unreadable. */
function fileMode(): WireLogMode {
  try {
    const flag = wireLogSwitchPath();
    if (!fs.existsSync(flag)) return "off";
    const text = fs.readFileSync(flag, "utf8").trim().toLowerCase();
    return text === "full" ? "full" : "summary";
  } catch {
    return "off";
  }
}

/** The env value that forces a mode, if one does. */
function envMode(): WireLogMode | null {
  const env = (process.env.ACPIO_WIRE_LOG ?? "").trim().toLowerCase();
  if (env === "full") return "full";
  if (env === "1" || env === "true" || env === "yes") return "summary";
  if (env === "0" || env === "false" || env === "no" || env === "off") return "off";
  return null;
}

export function readWireLogMode(): WireLogMode {
  return envMode() ?? fileMode();
}

/** Flip the switch; returns what the agent will actually do. */
export function writeWireLogMode(mode: WireLogMode): WireLogMode {
  const flag = wireLogSwitchPath();
  if (mode === "off") {
    fs.rmSync(flag, { force: true });
    return readWireLogMode();
  }
  fs.mkdirSync(path.dirname(flag), { recursive: true });
  fs.writeFileSync(flag, `${mode}\n`, "utf8");
  return readWireLogMode();
}

/** Every file under the log folder, as archive names and bytes read on demand. */
function logFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  walk("");
  return out.sort();
}

export function wireLogStatus(): WireLogStatusDto {
  const dir = wireLogDir();
  const sessions = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const rel of logFiles(dir)) {
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, rel)).size;
    } catch {
      continue;
    }
    files += 1;
    bytes += size;
    const name = path.basename(rel);
    if (name.endsWith(".jsonl")) sessions.add(name.slice(0, -".jsonl".length));
  }
  return { mode: readWireLogMode(), forcedByEnv: envMode() !== null, dir, sessions: sessions.size, files, bytes };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = (CRC_TABLE[(crc ^ data[i]) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only stamp a zip entry carries. */
function dosStamp(date: Date): { time: number; date: number } {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * A zip of the given entries, deflated per file.
 *
 * Written here rather than pulled in as a dependency: the shape needed is one
 * archive of already-compressible text, and that is a local file header, a
 * central directory and an end record — the whole format for "store or deflate
 * one file" is a page, and a page beats a library nobody else would use.
 */
export function zipEntries(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const stamp = dosStamp(new Date());
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data);
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field
    parts.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(stamp.time, 12);
    dir.writeUInt16LE(stamp.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, eocd]);
}

/**
 * The bundle Support asks for: the whole log folder, the switch that produced
 * it and a small `meta.json` saying which build wrote it. Throws when the folder
 * is too big to send — a support archive that nobody can attach is worse than a
 * clear refusal.
 */
export function buildWireLogArchive(sessionId?: string): {
  fileName: string;
  buffer: Buffer;
  files: number;
  bytes: number;
} {
  const dir = wireLogDir();
  const status = wireLogStatus();
  if (status.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `лог занимает ${(status.bytes / 1024 / 1024).toFixed(0)} МБ (больше ${MAX_ARCHIVE_BYTES / 1024 / 1024} МБ) — ` +
        "удали старые тела запросов или выключи режим full и собери архив снова",
    );
  }
  // One chat's own files: `<sid>.jsonl` and the `full` mode's `<sid>/` folder.
  // The log is one file per chat, so a warning can hand over exactly the turn
  // that moved its head instead of everything the machine ever sent.
  // The log names a chat by the first eight characters of its id.
  const only = (sessionId ?? "").trim().slice(0, 8);
  const mine = (rel: string): boolean => {
    if (!only) return true;
    const flat = rel.replace(/\\/g, "/");
    return flat === `${only}.jsonl` || flat.startsWith(`${only}/`);
  };
  const entries = logFiles(dir)
    .filter(mine)
    .map((rel) => ({
      name: `wire-log/${rel.replace(/\\/g, "/")}`,
      data: fs.readFileSync(path.join(dir, rel)),
    }));
  entries.push({
    name: "wire-log/meta.json",
    data: Buffer.from(
      `${JSON.stringify(
        {
          version: BUILD_INFO.version,
          released: BUILD_INFO.released,
          createdAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          mode: status.mode,
          sessions: status.sessions,
          files: status.files,
          bytes: status.bytes,
          ...(only ? { session: only } : {}),
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    fileName: `acpio-wire-log-${only ? `${only}-` : ""}${stamp}.zip`,
    buffer: zipEntries(entries),
    files: entries.length,
    bytes: entries.reduce((n, entry) => n + entry.data.length, 0),
  };
}
