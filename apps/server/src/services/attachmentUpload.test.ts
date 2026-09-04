import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACH_DIR, stageSessionUpload } from "./attachmentUpload.js";

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
      data: png.toString("base64"),
    });
    expect(saved.name).toBe("clipboard.png");
    expect(saved.path).toBe(path.join(cwd, ATTACH_DIR, "sess-1", "clipboard.png"));
    expect(await readFile(saved.path)).toEqual(png);
  });

  it("avoids clobbering an existing file name", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "acpio-attach-"));
    dirs.push(cwd);
    const data = Buffer.from("hello").toString("base64");
    const first = await stageSessionUpload("sess-1", cwd, {
      name: "shot.png",
      mime: "image/png",
      data,
    });
    const second = await stageSessionUpload("sess-1", cwd, {
      name: "shot.png",
      mime: "image/png",
      data,
    });
    expect(first.name).toBe("shot.png");
    expect(second.name).toBe("shot-2.png");
  });
});
