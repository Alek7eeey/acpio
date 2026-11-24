// @vitest-environment jsdom
// The folder browser must survive a starting path that is not a folder: a
// setting saved by an older build can hold anything (a provider endpoint was
// autofilled into one), and the folder it names may have been deleted since.
// Either way the dialog opens at its own default start with the list to walk —
// not empty, under a raw "Path not found".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { api } from "../lib/api";
import { ServerFolderBrowseDialog } from "./ServerFolderBrowseDialog";

vi.mock("../lib/api", () => ({
  api: {
    browseDirectory: vi.fn(),
    createFolder: vi.fn(),
  },
}));

const browseDirectory = vi.mocked(api.browseDirectory);

const home = {
  path: "/home/reader",
  parent: "/home",
  entries: [{ name: "projects", path: "/home/reader/projects" }],
};

beforeEach(() => {
  Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];
  browseDirectory.mockReset().mockImplementation(async (path?: string) => {
    if (path) throw new Error("Path not found");
    return home;
  });
});

afterEach(() => cleanup());

describe("ServerFolderBrowseDialog", () => {
  it("opens at its own start when the saved folder is gone", async () => {
    render(
      <I18nProvider>
        <ServerFolderBrowseDialog
          open
          initialPath="/deleted/folder"
          onClose={() => {}}
          onSelect={() => {}}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("projects")).toBeTruthy());
    expect(screen.queryByText("Path not found")).toBeNull();
    // Asked for the saved path, got nothing, asked again with no path.
    expect(browseDirectory.mock.calls.map((c) => c[0])).toEqual(["/deleted/folder", undefined]);
  });

  it("still reports a failure the default start shares", async () => {
    browseDirectory.mockRejectedValue(new Error("Path not found"));
    render(
      <I18nProvider>
        <ServerFolderBrowseDialog open onClose={() => {}} onSelect={() => {}} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("Path not found")).toBeTruthy());
  });
});
