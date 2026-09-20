// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { GitChangesSidePanel } from "./GitChangesSidePanel";

const apiMock = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitDiff: vi.fn(),
  gitShow: vi.fn(),
  gitCommitDetail: vi.fn(),
  gitSync: vi.fn(),
  gitStash: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

const STATUS = {
  repo: true,
  root: "C:/repo",
  branch: "main",
  dirty: true,
  conflict: false,
  branches: ["main"],
  files: [
    {
      path: "src/a.ts",
      index: " ",
      worktree: "M",
      staged: false,
      unstaged: true,
      additions: 3,
      deletions: 1,
    },
  ],
  stagedCount: 0,
  unstagedCount: 1,
  additions: 3,
  deletions: 1,
  stashCount: 0,
  aheadCount: 0,
  behindCount: 0,
};

function fileDiff(path: string) {
  return {
    diff: [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-old", "+new"].join(
      "\n",
    ),
  };
}

function renderPanel(props: Partial<Parameters<typeof GitChangesSidePanel>[0]> = {}) {
  const onFullscreenChange = vi.fn();
  const view = render(
    <I18nProvider>
      <div>
        <GitChangesSidePanel
          sessionId="s1"
          open
          status={STATUS}
          branchBusy={false}
          fullscreen={false}
          onClose={vi.fn()}
          onStatusChange={vi.fn()}
          onCheckout={vi.fn().mockResolvedValue(undefined)}
          onFullscreenChange={onFullscreenChange}
          {...props}
        />
      </div>
    </I18nProvider>,
  );
  return { onFullscreenChange, ...view };
}

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
  apiMock.gitStatus.mockResolvedValue(STATUS);
  apiMock.gitLog.mockResolvedValue({ commits: [], outgoing: [] });
  apiMock.gitCommitDetail.mockResolvedValue({ detail: null });
  apiMock.gitSync.mockResolvedValue({ status: STATUS, conflict: false, output: "" });
  apiMock.gitStash.mockResolvedValue({ status: STATUS });
  apiMock.gitDiff.mockImplementation((_id: string, path: string) => Promise.resolve(fileDiff(path)));
  apiMock.gitShow.mockImplementation((_id: string, _rev: string, path: string) =>
    Promise.resolve(fileDiff(path)),
  );
  // jsdom lacks matchMedia/ResizeObserver, and every element measures 0px wide:
  // pin a desktop page so the panel docks a navigator column beside the stage.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1440,
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** jsdom has no real viewport: pin the width the panel reads for its layout. */
async function withViewportWidth(width: number, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(window, "innerWidth", original);
  }
}

describe("GitChangesSidePanel", () => {
  it("keeps the tab, list and sync controls in one row at the bottom of the navigator", async () => {
    renderPanel();
    const tabs = await screen.findByRole("tab", { name: "Изменения" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "История" })).toBeTruthy());

    // One row holds the changes/history switch, the list/tree switch and the sync
    // buttons, so none of them claims a row of its own.
    const row = tabs.closest("[role='toolbar']") as HTMLElement;
    expect(row).toBeTruthy();
    const siblings = [
      screen.getByRole("tab", { name: "История" }),
      screen.getByRole("button", { name: "Плоский список" }),
      screen.getByRole("button", { name: "Дерево папок" }),
      screen.getByRole("button", { name: "Pull" }),
      screen.getByRole("button", { name: "Push" }),
    ];
    for (const control of siblings) {
      expect(row.contains(control)).toBe(true);
    }

    // ...and it is the navigator's last row: the head carries branch and counts only.
    const navigator = row.parentElement as HTMLElement;
    expect(navigator.lastElementChild).toBe(row);
    expect(navigator.firstElementChild?.tagName).toBe("HEADER");
    expect(navigator.firstElementChild?.contains(row)).toBe(false);
    expect(navigator.firstElementChild?.contains(tabs)).toBe(false);
  });

  it("keeps fetch and the stash pair behind the overflow button", async () => {
    const user = userEvent.setup();
    renderPanel({ status: { ...STATUS, dirty: true, stashCount: 0 } });
    const more = await screen.findByRole("button", { name: "Ещё" });
    expect(more.closest("[role='toolbar']")).toBeTruthy();

    // Out of the row: three more buttons there are what would wrap the row in two.
    expect(screen.queryByRole("menuitem", { name: "Fetch" })).toBeNull();

    await user.click(more);
    const fetch = screen.getByRole("menuitem", { name: "Fetch" });
    expect(screen.getByRole("menuitem", { name: "Stash" })).toBeTruthy();
    // An empty stash is nothing to pop.
    expect((screen.getByRole("menuitem", { name: "Pop" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(fetch);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(apiMock.gitSync).toHaveBeenCalledWith("s1", "fetch");
  });

  it("fills the screen from the full view, and stays a dock otherwise", async () => {
    const { container, unmount } = renderPanel({ fullscreen: false });
    const docked = await screen.findByRole("complementary", { name: "Git" });
    expect(container.contains(docked)).toBe(true);
    expect(docked.parentElement).not.toBe(document.body);
    unmount();

    const full = renderPanel({ fullscreen: true });
    const panel = await screen.findByRole("dialog", { name: "Diff на весь экран" });
    // The full view is the whole screen: portalled onto the body, so no page
    // container or panel dock can clip it to a slice.
    expect(full.container.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(document.body);
  });

  it("re-reads the file diffs when the reader asks for a refresh", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("s1", "src/a.ts"));
    apiMock.gitDiff.mockClear();

    // The same file set can still hold different content: a refresh must re-read
    // the diff, not just the status the poll already keeps current.
    await user.click(await screen.findByRole("button", { name: "Обновить" }));

    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("s1", "src/a.ts"));
  });

  it("takes the whole viewport on a phone, where the shell header and dock would box it in", async () => {
    await withViewportWidth(390, async () => {
      const { container } = renderPanel();
      const panel = await screen.findByRole("complementary", { name: "Git" });
      expect(container.contains(panel)).toBe(false);
      expect(panel.parentElement).toBe(document.body);
    });
  });

  it("keeps a way out on a phone when there is no repo to show", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await withViewportWidth(390, async () => {
      renderPanel({ status: { ...STATUS, repo: false }, onClose });
      // The takeover covers the shell header, so the panel carries the exit itself.
      await user.click(await screen.findByRole("button", { name: "Назад" }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
