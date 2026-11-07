// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { EditorEntry } from "../lib/editorApi";

const treeMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/editorApi", () => ({
  editorApi: { tree: treeMock },
}));

const { Tree } = await import("./EditorPage");

const entry = (path: string, dir = false): EditorEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  dir,
});

/** A folder listing the tree asks for, keyed by the path it asks about. */
const FS: Record<string, EditorEntry[]> = {
  "": [entry("web", true), entry("README.md")],
  web: [entry("web/host", true), entry("web/package.json")],
  "web/host": [entry("web/host/src", true), entry("web/host/vite.config.ts")],
  "web/host/src": [entry("web/host/src/index.ts"), entry("web/host/src/app.ts")],
};

describe("Tree: «Показать файл в дереве»", () => {
  beforeEach(() => {
    localStorage.clear();
    treeMock.mockReset();
    // The server resolves the folder case-insensitively, as Windows does.
    treeMock.mockImplementation(async (_root: string, path: string) => ({
      entries: FS[path.toLowerCase()] ?? [],
    }));
    // jsdom has no layout: the call itself is what we can check.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the folders above the path, rings the row and scrolls to it", async () => {
    render(
      <Tree
        root="/repo"
        onOpen={() => {}}
        active={null}
        changed={new Set()}
        reveal={{ path: "web/host/src/index.ts", seq: 1 }}
      />,
    );

    const row = await waitFor(() => {
      const found = document.querySelector('[title="web/host/src/index.ts"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    expect(row.className).toContain("treeRowRevealed");
    // The row appears a frame or two after the folders above it finish loading.
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    // The folders on the way are open, or the row could not be on screen.
    for (const dir of ["web", "web/host", "web/host/src"]) {
      expect(treeMock).toHaveBeenCalledWith("/repo", dir);
    }
  });

  it("finds the row when git spells the path in another case", async () => {
    render(
      <Tree
        root="/repo"
        onOpen={() => {}}
        active={null}
        changed={new Set()}
        reveal={{ path: "WEB/Host/src/index.ts", seq: 1 }}
      />,
    );

    const row = await waitFor(() => {
      const found = document.querySelector('[title="web/host/src/index.ts"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.className).toContain("treeRowRevealed");
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("puts the ring on the row after a reload with folders already open", async () => {
    localStorage.setItem('acpio.editor.treeOpen.v1:/repo', JSON.stringify(["web", "web/host"]));
    render(
      <Tree
        root="/repo"
        onOpen={() => {}}
        active={null}
        changed={new Set()}
        reveal={{ path: "web/host/vite.config.ts", seq: 1 }}
      />,
    );

    const row = await waitFor(() => {
      const found = document.querySelector('[title="web/host/vite.config.ts"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.className).toContain("treeRowRevealed");
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("reveals nothing until a request arrives", async () => {
    render(<Tree root="/repo" onOpen={() => {}} active={null} changed={new Set()} />);
    await waitFor(() => expect(treeMock).toHaveBeenCalledWith("/repo", ""));
    expect(document.querySelectorAll('[title="web/package.json"]').length).toBe(0);
  });
});
