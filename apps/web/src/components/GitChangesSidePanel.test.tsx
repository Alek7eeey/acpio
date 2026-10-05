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
  protectedBranches: ["main"],
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
          onDeleteBranch={vi.fn().mockResolvedValue({ ok: true, unmerged: false })}
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
  it("keeps the tab switch in the navigator header and sync actions in the tools row", async () => {
    renderPanel();
    const tabs = await screen.findByRole("tab", { name: "Изменения" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "История" })).toBeTruthy());

    // The tab switch lives in the header's top row, next to the close button.
    const headTop = tabs.closest("header") as HTMLElement;
    expect(headTop).toBeTruthy();
    expect(headTop.contains(screen.getByRole("tab", { name: "История" }))).toBe(true);

    // The tools row under the header holds the list/tree switch and the sync
    // buttons; the navigator has no bottom bar anymore.
    const listBtn = screen.getByRole("button", { name: "Плоский список" });
    const toolsRow = listBtn.closest("[role='toolbar']") as HTMLElement;
    expect(toolsRow).toBeTruthy();
    expect(toolsRow.contains(screen.getByRole("button", { name: "Дерево папок" }))).toBe(true);
    expect(toolsRow.contains(screen.getByRole("button", { name: "Pull" }))).toBe(true);
    expect(toolsRow.contains(screen.getByRole("button", { name: "Push" }))).toBe(true);
    expect(toolsRow.contains(tabs)).toBe(false);

    // ...and it is the navigator's last row: the head carries branch, tab switch and counts only.
    const navigator = toolsRow.parentElement as HTMLElement;
    expect(navigator.firstElementChild?.tagName).toBe("HEADER");
    expect(navigator.firstElementChild?.contains(toolsRow)).toBe(false);
  });

  it("shows fetch, stash and pop as direct toolbar buttons", async () => {
    const user = userEvent.setup();
    renderPanel({ status: { ...STATUS, dirty: true, stashCount: 0 } });
    const stash = await screen.findByRole("button", { name: "Stash" });
    // No overflow: every rare action is a plain button in the tools row.
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
    // An empty stash is nothing to pop.
    expect((screen.getByRole("button", { name: "Pop" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(apiMock.gitSync).toHaveBeenCalledWith("s1", "fetch"));
    expect(stash).toBeTruthy();
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

  it("marks the refresh button busy while the re-read is still running", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalledWith("s1", "src/a.ts"));

    // The poll already keeps the lists current, so a manual refresh can finish
    // without changing a pixel: the button itself has to say the work is pending.
    const gate = Promise.withResolvers<typeof STATUS>();
    apiMock.gitStatus.mockImplementation(() => gate.promise);
    const button = await screen.findByRole("button", { name: "Обновить" });
    expect(button.getAttribute("aria-busy")).toBe("false");

    await user.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect((button as HTMLButtonElement).disabled).toBe(true);

    gate.resolve(STATUS);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("false"), { timeout: 2000 });
    expect((button as HTMLButtonElement).disabled).toBe(false);
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
