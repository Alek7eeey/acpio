import { describe, it, expect } from "vitest";
import { DRIVES_ROOT, isImageFile, splitPathSegments } from "./pathSegments";

describe("isImageFile", () => {
  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])(
    "recognizes lowercase .%s files",
    (ext) => {
      expect(isImageFile(`photo.${ext}`)).toBe(true);
    },
  );

  it.each(["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG", "BMP", "ICO", "AVIF"])(
    "recognizes uppercase .%s files",
    (ext) => {
      expect(isImageFile(`photo.${ext}`)).toBe(true);
    },
  );

  it("recognizes mixed-case extensions", () => {
    expect(isImageFile("photo.JpEg")).toBe(true);
    expect(isImageFile("PHOTO.PNG")).toBe(true);
  });

  it.each(["txt", "md", "json", "exe"])("rejects .%s files", (ext) => {
    expect(isImageFile(`notes.${ext}`)).toBe(false);
  });

  it("only inspects the last dot-segment as the extension", () => {
    expect(isImageFile("photo.png.bak")).toBe(false);
    expect(isImageFile("archive.tar.gz")).toBe(false);
  });

  it("rejects a name with no extension", () => {
    expect(isImageFile("photo")).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(isImageFile("")).toBe(false);
  });

  it("rejects a trailing dot", () => {
    expect(isImageFile("photo.")).toBe(false);
  });

  it("treats a dotfile named .png as an image (its extension is png)", () => {
    expect(isImageFile(".png")).toBe(true);
  });

  it("treats a bare extension word as an image", () => {
    expect(isImageFile("png")).toBe(true);
  });
});

describe("splitPathSegments", () => {
  it("maps the drives root to a single segment with the custom label", () => {
    expect(splitPathSegments(DRIVES_ROOT, "Drives")).toEqual([
      { label: "Drives", path: DRIVES_ROOT },
    ]);
  });

  it("treats a unix root as a single segment", () => {
    expect(splitPathSegments("/", "Drives")).toEqual([{ label: "/", path: "/" }]);
  });

  it("treats a backslash root as a single segment", () => {
    expect(splitPathSegments("\\", "Drives")).toEqual([{ label: "/", path: "/" }]);
  });

  it("returns an empty list for empty or whitespace-only paths", () => {
    expect(splitPathSegments("", "Drives")).toEqual([]);
    expect(splitPathSegments("   ", "Drives")).toEqual([]);
  });

  it("splits a windows drive path into breadcrumbs with backslash paths", () => {
    expect(splitPathSegments("C:\\Users\\bob", "Drives")).toEqual([
      { label: "Drives", path: "Computer" },
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "bob", path: "C:\\Users\\bob" },
    ]);
  });

  it("normalizes forward slashes on a windows drive into backslash paths", () => {
    expect(splitPathSegments("C:/Users", "Drives")).toEqual([
      { label: "Drives", path: "Computer" },
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
    ]);
  });

  it("splits a unix absolute path with a root segment", () => {
    expect(splitPathSegments("/usr/local", "Drives")).toEqual([
      { label: "/", path: "/" },
      { label: "usr", path: "/usr" },
      { label: "local", path: "/usr/local" },
    ]);
  });

  it("splits a relative path without a root segment", () => {
    expect(splitPathSegments("relative/path", "Drives")).toEqual([
      { label: "relative", path: "relative" },
      { label: "path", path: "relative/path" },
    ]);
  });

  it("collapses doubled slashes in unix absolute paths", () => {
    expect(splitPathSegments("//usr//local", "Drives")).toEqual([
      { label: "/", path: "/" },
      { label: "usr", path: "/usr" },
      { label: "local", path: "/usr/local" },
    ]);
  });
});
