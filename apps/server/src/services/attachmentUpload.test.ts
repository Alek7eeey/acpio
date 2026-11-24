import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACH_DIR, discardStagedUpload, stageSessionUpload } from "./attachmentUpload.js";

/** The body the route hands over: the request stream, byte for byte. */
function body(bytes: Buffer | string): Readable {
  return Readable.from([Buffer.from(bytes)]);
}

describe("stageSessionUpload", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a clipboard image under the session attachments folder", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const saved = await stageSessionUpload("sess-1", cwd, {
      name: "clipboard.png",
      mime: "image/png",
      stream: body(png),
    });
    expect(saved.name).toBe("clipboard.png");
    expect(saved.path).toBe(path.join(cwd, ATTACH_DIR, "sess-1", "clipboard.png"));
    expect(await readFile(saved.path)).toEqual(png);
  });

  it("avoids clobbering an existing file name", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    const bytes = Buffer.from("hello");
    const first = await stageSessionUpload("sess-1", cwd, {
      name: "shot.png",
      mime: "image/png",
      stream: body(bytes),
    });
    const second = await stageSessionUpload("sess-1", cwd, {
      name: "shot.png",
      mime: "image/png",
      stream: body(bytes),
    });
    expect(first.name).toBe("shot.png");
    expect(second.name).toBe("shot-2.png");
  });

  // The report: a 16 MB log was refused in the chat, while the board took it
  // and lost it invisibly (the server answered 413 and the card kept only the
  // name). The size of an attachment is the disk's business; the body is
  // streamed, so nothing about it is held in memory.
  it("takes a body far above the old 15 MB cap", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    const big = Buffer.alloc(16 * 1024 * 1024, 120);
    const saved = await stageSessionUpload("sess-1", cwd, {
      name: "largeWindows1251_3.txt",
      mime: "text/plain",
      stream: body(big),
    });
    expect(saved.size).toBe(big.length);
    expect((await readFile(saved.path)).length).toBe(big.length);
  });

  it("refuses a body past its ceiling and leaves nothing on disk", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    await expect(
      stageSessionUpload("sess-1", cwd, {
        name: "huge.bin",
        stream: body(Buffer.alloc(2048, 7)),
        limit: 1024,
      }),
    ).rejects.toThrow("File too large");
    // A half-written blob is a file the reader never asked for.
    expect(await readdir(path.join(cwd, ATTACH_DIR, "sess-1"))).toEqual([]);
  });

  // The reader's own folder: a value relative to the chat's folder keeps the
  // project tidy (`docs/attachments`), and it is theirs to name.
  it("stages into the folder settings.attachmentsDir points at", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    const saved = await stageSessionUpload(
      "sess-1",
      cwd,
      { name: "shot.png", mime: "image/png", stream: body("png") },
      "docs/attachments",
    );
    expect(saved.path).toBe(path.join(cwd, "docs", "attachments", "sess-1", "shot.png"));
    // The chip's removal still finds it: a staged file nobody points at is
    // exactly what the discard is for.
    expect(await discardStagedUpload("sess-1", cwd, saved.path, "docs/attachments")).toBe(true);
    expect(await readdir(path.dirname(saved.path))).toEqual([]);
  });

  it("takes an absolute attachmentsDir and nothing outside it", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-out-"));
    dirs.push(cwd, elsewhere);
    const saved = await stageSessionUpload(
      "sess-1",
      cwd,
      { name: "log.txt", mime: "text/plain", stream: body("hello") },
      elsewhere,
    );
    expect(saved.path).toBe(path.join(elsewhere, "sess-1", "log.txt"));
    // A path this chat never staged into is not ours to delete.
    const project = path.join(cwd, ATTACH_DIR, "sess-1", "keep.txt");
    expect(await discardStagedUpload("sess-1", cwd, project, elsewhere)).toBe(false);
  });

  it("calls an empty body an empty upload", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    await expect(
      stageSessionUpload("sess-1", cwd, { name: "nothing.txt", stream: body(Buffer.alloc(0)) }),
    ).rejects.toThrow("Empty upload");
  });
});
