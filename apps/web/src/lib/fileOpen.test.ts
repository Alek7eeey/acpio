// @vitest-environment jsdom
// A click on a file is the same click everywhere, so all four places ask this
// module. What it must not do is swallow a click it cannot honour: a binary file
// and a path outside every folder the code pane knows have to fall back to what
// the click did before the setting existed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@acpio/shared";

vi.mock("./api", () => ({ api: {} }));

import { useAppStore } from "./store";
import {
  canOpenInEditor,
  editorRelPath,
  editorRootFor,
  isAbsolutePath,
  openFileInEditor,
} from "./fileOpen";

beforeEach(() => {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, fileOpenTarget: "editor", editorSplit: "left" },
    openEditors: [],
    knownFolders: [],
    activeSession: null,
    sessionDetails: {},
    editorReveal: null,
  });
});

describe("editorRelPath", () => {
  it("keeps the file's own spelling under the folder", () => {
    expect(editorRelPath("E:\\share\\acpio", "E:/share/acpio/apps/web/src/App.tsx")).toBe(
      "apps/web/src/App.tsx",
    );
  });

  it("compares folders case-insensitively, as Windows does", () => {
    expect(editorRelPath("e:/Share/Acpio", "E:\\share\\acpio\\README.md")).toBe("README.md");
  });

  it("refuses the folder itself and anything beside it", () => {
    expect(editorRelPath("E:/share/acpio", "E:/share/acpio")).toBeNull();
    expect(editorRelPath("E:/share/acpio", "E:/share/acpio-other/x.ts")).toBeNull();
    expect(editorRelPath("E:/share/acpio", "C:/tmp/x.ts")).toBeNull();
  });
});

describe("canOpenInEditor", () => {
  it("takes text and refuses what the pane would read as garbage", () => {
    expect(canOpenInEditor("E:/a/notes.md")).toBe(true);
    expect(canOpenInEditor("E:/a/shot.PNG")).toBe(false);
    expect(canOpenInEditor("E:/a/archive.zip")).toBe(false);
  });
});

describe("editorRootFor", () => {
  const abs = "E:/share/acpio/README.md";

  it("prefers the chat's own folder over the one on screen", () => {
    expect(
      editorRootFor(abs, {
        sessionCwd: "E:/share/acpio",
        activeCwd: "E:/share",
        panes: ["E:/share"],
      }),
    ).toBe("E:/share/acpio");
  });

  it("falls back to a known folder when no open pane holds the file", () => {
    expect(editorRootFor(abs, { panes: ["E:/other"], folders: ["E:/share/acpio"] })).toBe(
      "E:/share/acpio",
    );
  });

  it("has no answer for a path none of them holds", () => {
    expect(editorRootFor(abs, { sessionCwd: "E:/other", panes: ["E:/share/gitea-mcp"] })).toBeNull();
  });
});

describe("isAbsolutePath", () => {
  it("tells a path on the machine from one relative to the chat folder", () => {
    expect(isAbsolutePath("C:\\tmp\\x.png")).toBe(true);
    expect(isAbsolutePath("/home/me/x.png")).toBe(true);
    expect(isAbsolutePath("shots/x.png")).toBe(false);
  });
});

describe("openFileInEditor", () => {
  it("hands the file to the pane at the folder that holds it", () => {
    useAppStore.setState({ knownFolders: ["E:/share/acpio"] });
    expect(openFileInEditor({ path: "E:/share/acpio/apps/web/src/App.tsx", line: 12 })).toBe(true);
    expect(useAppStore.getState().editorReveal).toMatchObject({
      root: "E:/share/acpio",
      rel: "apps/web/src/App.tsx",
      line: 12,
    });
  });

  it("leaves the click to the file itself when the setting says so", () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, fileOpenTarget: "storage" },
      knownFolders: ["E:/share/acpio"],
    });
    expect(openFileInEditor({ path: "E:/share/acpio/README.md" })).toBe(false);
    expect(useAppStore.getState().editorReveal).toBeNull();
  });

  it("refuses a picture and a folder it does not know", () => {
    useAppStore.setState({ knownFolders: ["E:/share/acpio"] });
    expect(openFileInEditor({ path: "E:/share/acpio/shots/screen.png" })).toBe(false);
    expect(openFileInEditor({ path: "E:/elsewhere/notes.md" })).toBe(false);
  });
});
