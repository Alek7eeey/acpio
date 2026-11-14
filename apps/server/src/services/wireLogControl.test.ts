import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWireLogArchive,
  readWireLogMode,
  wireLogStatus,
  wireLogSwitchPath,
  writeWireLogMode,
  zipEntries,
} from "./wireLogControl.js";

/** A zip read back the way a recipient's unzip would: central directory first. */
function readZip(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  const eocdAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocdAt).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocdAt + 10);
  let at = buffer.readUInt32LE(eocdAt + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localAt + 26);
    const localExtraLength = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataAt, dataAt + compressed);
    out.push({
      name,
      data: method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

describe("wire log control", () => {
  let dir = "";
  const saved = { dir: process.env.ACPIO_WIRE_LOG_DIR, env: process.env.ACPIO_WIRE_LOG };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-log-control-"));
    process.env.ACPIO_WIRE_LOG_DIR = dir;
    delete process.env.ACPIO_WIRE_LOG;
  });

  afterEach(() => {
    if (saved.dir === undefined) delete process.env.ACPIO_WIRE_LOG_DIR;
    else process.env.ACPIO_WIRE_LOG_DIR = saved.dir;
    if (saved.env === undefined) delete process.env.ACPIO_WIRE_LOG;
    else process.env.ACPIO_WIRE_LOG = saved.env;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("turns recording on and off through the file the agent reads", () => {
    expect(readWireLogMode()).toBe("off");
    expect(writeWireLogMode("summary")).toBe("summary");
    // The contents are the mode: `summary` is the word the agent looks for.
    expect(fs.readFileSync(wireLogSwitchPath(), "utf8").trim()).toBe("summary");
    expect(writeWireLogMode("full")).toBe("full");
    expect(fs.readFileSync(wireLogSwitchPath(), "utf8").trim()).toBe("full");
    // Off is the absence of the switch, not a third value in it.
    expect(writeWireLogMode("off")).toBe("off");
    expect(fs.existsSync(wireLogSwitchPath())).toBe(false);
  });

  it("says so when the environment pins the mode instead of the switch", () => {
    process.env.ACPIO_WIRE_LOG = "full";
    expect(readWireLogMode()).toBe("full");
    expect(wireLogStatus().forcedByEnv).toBe(true);
    // The switch still flips — it just cannot win, and the status says that.
    expect(writeWireLogMode("off")).toBe("full");
  });

  it("counts the folder it reports: chats by file, bodies included", () => {
    const written = [
      ["aaaa1111.jsonl", "{}\n{}\n"],
      [path.join("aaaa1111", "0001.req.json"), "{}"],
      ["bbbb2222.jsonl", "{}\n"],
    ] as const;
    for (const [name, text] of written) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text, "utf8");
    }
    const status = wireLogStatus();
    expect(status.sessions).toBe(2);
    expect(status.files).toBe(3);
    expect(status.bytes).toBe(written.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0));
    expect(status.dir).toBe(dir);
  });

  it("zips the folder into an archive a reader can open, meta included", () => {
    fs.writeFileSync(path.join(dir, "aaaa1111.jsonl"), `${JSON.stringify({ kind: "request" })}\n`, "utf8");
    fs.mkdirSync(path.join(dir, "aaaa1111"));
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "привет" }] });
    fs.writeFileSync(path.join(dir, "aaaa1111", "0001.req.json"), body, "utf8");
    writeWireLogMode("full");

    const archive = buildWireLogArchive();
    expect(archive.fileName).toMatch(/^acpio-wire-log-.*\.zip$/);
    const entries = readZip(archive.buffer);
    const names = entries.map((entry) => entry.name).sort();
    expect(names).toEqual([
      "wire-log/aaaa1111.jsonl",
      "wire-log/aaaa1111/0001.req.json",
      "wire-log/meta.json",
      "wire-log/on",
    ]);
    const read = (name: string) => entries.find((entry) => entry.name === name)?.data.toString("utf8");
    expect(read("wire-log/aaaa1111/0001.req.json")).toBe(body);
    expect(JSON.parse(read("wire-log/meta.json") ?? "{}").mode).toBe("full");
  });

  it("narrows the archive to one chat when the warning asks for it", () => {
    fs.writeFileSync(path.join(dir, "aaaa1111.jsonl"), "{\n", "utf8");
    fs.writeFileSync(path.join(dir, "bbbb2222.jsonl"), "{\n", "utf8");
    fs.mkdirSync(path.join(dir, "aaaa1111"));
    fs.writeFileSync(path.join(dir, "aaaa1111", "0001.req.json"), "{}", "utf8");
    fs.mkdirSync(path.join(dir, "bbbb2222"));
    fs.writeFileSync(path.join(dir, "bbbb2222", "0001.req.json"), "{}", "utf8");
    writeWireLogMode("full");

    // The chat hands its own id over, complete: the log names a chat by the
    // first eight characters of it.
    const archive = buildWireLogArchive("aaaa1111-2222-3333-4444");
    const names = readZip(archive.buffer)
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual([
      "wire-log/aaaa1111.jsonl",
      "wire-log/aaaa1111/0001.req.json",
      "wire-log/meta.json",
    ]);
    expect(archive.fileName).toContain("aaaa1111");
  });

  it("keeps a large entry intact through deflate", () => {
    const big = Buffer.from("ж".repeat(200_000), "utf8");
    const entries = readZip(zipEntries([{ name: "wire-log/big.txt", data: big }]));
    expect(entries[0].data.length).toBe(big.length);
    expect(entries[0].data.equals(big)).toBe(true);
  });
});
