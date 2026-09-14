// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { setDiffLayout } from "../lib/diffLayout";
import { GitDiffStage } from "./GitDiffStage";

const apiMock = vi.hoisted(() => ({ gitDiff: vi.fn(), gitShow: vi.fn() }));
vi.mock("../lib/api", () => ({ api: apiMock }));

function fileDiff(path: string, body: string) {
  return {
    diff: [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-old", `+${body}`].join(
      "\n",
    ),
  };
}

const SMALL = ["src/a.ts", "src/b.ts", "assets/logo.png"];
const MANY = Array.from({ length: 40 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);

function fileBlock(path: string) {
  return document.querySelector<HTMLElement>(`[data-diff-path="${path}"]`);
}

function renderViewer(paths: string[] = SMALL, props: Partial<Parameters<typeof GitDiffStage>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <I18nProvider>
      <GitDiffStage
        sessionId="s1"
        scope={{ mode: "working" }}
        files={paths.map((path) => ({ path, badge: "M" }))}
        initialPath={null}
        onClose={onClose}
        {...props}
      />
    </I18nProvider>,
  );
  return { onClose, ...view };
}

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
  act(() => setDiffLayout("stacked"));
  apiMock.gitDiff.mockImplementation((_id: string, path: string) => Promise.resolve(fileDiff(path, `new-${path}`)));
  apiMock.gitShow.mockImplementation((_id: string, _rev: string, path: string) =>
    Promise.resolve(fileDiff(path, `new-${path}`)),
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GitDiffStage", () => {
  it("requests each file's diff separately and shows only that file", async () => {
    renderViewer();

    await waitFor(() => expect(fileBlock("src/b.ts")).toBeTruthy());
    // One request per file, keyed by path — not one whole-repo diff.
    expect(apiMock.gitDiff.mock.calls.map((call) => call[1]).sort()).toEqual([
      "assets/logo.png",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(fileBlock("src/b.ts")?.textContent).toContain("new-src/b.ts");
    expect(fileBlock("src/b.ts")?.textContent).not.toContain("new-src/a.ts");
  });

  it("loads only what is on screen in a large changeset", async () => {
    renderViewer(MANY);

    await waitFor(() => expect(apiMock.gitDiff).toHaveBeenCalled());
    const requested = apiMock.gitDiff.mock.calls.map((call) => call[1] as string);
    // The tail of the list must stay unloaded until it is scrolled to.
    expect(requested).not.toContain("src/f39.ts");
    expect(requested.length).toBeLessThan(MANY.length);
  });

  it("jumps to the file picked from the bottom sheet", async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Изменённые файлы" }));
    await user.click(await screen.findByRole("button", { name: "src/b.ts" }));

    await waitFor(() => expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "src/b.ts" })).toBeNull();
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("steps through files with the bottom arrows", async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Следующий файл" }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Предыдущий файл" }));
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Предыдущий файл" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches the sheet between a flat list and a folder tree", async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Изменённые файлы" }));

    // Flat list shows full paths, no folder rows.
    expect(screen.queryByRole("button", { name: "src" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Дерево папок" }));
    const srcDir = await screen.findByRole("button", { name: "src" });
    expect(screen.getByRole("button", { name: "assets" })).toBeTruthy();

    await user.click(srcDir);
    expect(screen.queryByRole("button", { name: "src/a.ts" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "src/a.ts" })).toBeTruthy();

    // Picking from the tree still jumps, and the choice is remembered.
    await user.click(screen.getByRole("button", { name: "src/b.ts" }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Изменённые файлы" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "assets" })).toBeTruthy());
    expect(localStorage.getItem("acpio.gitFileSheetView.v1")).toBe("tree");
  });

  it("opens on the file the panel had selected", async () => {
    renderViewer(SMALL, { initialPath: "assets/logo.png" });

    await waitFor(() => expect(screen.getByText("3 / 3")).toBeTruthy());
  });

  it("re-centres whenever the host picks a file, even the one already open", async () => {
    const viewerProps: Partial<Parameters<typeof GitDiffStage>[0]> = {
      sessionId: "s1",
      scope: { mode: "working" },
      initialPath: "src/a.ts",
      jumpToken: 0,
      onClose: () => {},
    };
    const files = SMALL.map((path) => ({ path, badge: "M" }));
    const { rerender } = render(
      <I18nProvider>
        <GitDiffStage {...viewerProps} files={files} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());

    rerender(
      <I18nProvider>
        <GitDiffStage {...viewerProps} files={files} initialPath="assets/logo.png" jumpToken={1} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("3 / 3")).toBeTruthy());

    // Same file again: the pick is a request to go back to its top, not a no-op.
    rerender(
      <I18nProvider>
        <GitDiffStage {...viewerProps} files={files} initialPath="assets/logo.png" jumpToken={2} />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        behavior: "auto",
      }),
    );
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });

  it("hands the file sheet to its host when the host is narrow", async () => {
    renderViewer(SMALL, { compact: true });

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    // The host's navigator is the picker there, so the stage keeps only the diff.
    expect(screen.queryByRole("button", { name: "Изменённые файлы" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Следующий файл" })).toBeNull();
    expect(screen.getByRole("button", { name: "Назад" })).toBeTruthy();
    // ...and the reading controls, which are the stage's own, stay in reach.
    expect(screen.getByRole("button", { name: "Список" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Перенос длинных строк" })).toBeTruthy();
  });

  it("offers the full view and reports its state back", async () => {
    const user = userEvent.setup();
    const onToggleExpand = vi.fn();
    const view = renderViewer(SMALL, { onToggleExpand });

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    const open = screen.getByRole("button", { name: "Diff на весь экран" });
    expect(open.getAttribute("aria-pressed")).toBe("false");

    await user.click(open);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);

    // The host flips the flag: the same control is now the way out, and the
    // host — not the stage — owns dismissal there.
    view.rerender(
      <I18nProvider>
        <GitDiffStage
          sessionId="s1"
          scope={{ mode: "working" }}
          files={SMALL.map((path) => ({ path, badge: "M" }))}
          initialPath={null}
          expanded
          onToggleExpand={onToggleExpand}
        />
      </I18nProvider>,
    );

    const exit = screen.getByRole("button", { name: "Закрыть полноэкранный diff" });
    expect(exit.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Diff на весь экран" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();
  });

  it("keeps the reader's file when the file list is refreshed", async () => {
    const user = userEvent.setup();
    const viewerProps: Partial<Parameters<typeof GitDiffStage>[0]> = {
      sessionId: "s1",
      scope: { mode: "working" },
      initialPath: "src/a.ts",
      onClose: () => {},
    };
    const { rerender } = render(
      <I18nProvider>
        <GitDiffStage {...viewerProps} files={SMALL.map((path) => ({ path, badge: "M" }))} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Изменённые файлы" }));
    await user.click(await screen.findByRole("button", { name: "assets/logo.png" }));
    expect(screen.getByText("3 / 3")).toBeTruthy();

    // The repo changed under the reader (an agent wrote a file): the view must
    // reopen on the file being read, not on the panel's selection.
    rerender(
      <I18nProvider>
        <GitDiffStage
          {...viewerProps}
          files={[...SMALL, "src/c.ts"].map((path) => ({ path, badge: "M" }))}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("3 / 4")).toBeTruthy());
  });

  it("keeps the file header to identity and the reading controls in the bottom bar", async () => {
    renderViewer(SMALL, { onToggleExpand: vi.fn() });

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeTruthy());
    const topBar = screen.getByRole("button", { name: "Назад" }).closest("header");
    const bottomBar = screen.getByRole("button", { name: "Следующий файл" }).closest("nav");
    // The header names the file being read; everything the reader touches sits
    // in the bar under it, next to the file stepper.
    expect(topBar?.textContent).toContain("Изменения");
    expect(topBar?.textContent).toContain("1 / 3");
    expect(bottomBar).toBeTruthy();
    for (const name of [
      "Список",
      "Две колонки",
      "Все файлы",
      "Один файл",
      "Перенос длинных строк",
      "Diff на весь экран",
    ]) {
      const control = screen.getByRole("button", { name });
      expect(bottomBar?.contains(control)).toBe(true);
      expect(topBar?.contains(control)).toBe(false);
    }
  });

  it("switches the diff between unified and split", async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => expect(fileBlock("src/a.ts")).toBeTruthy());
    const split = screen.getByRole("button", { name: "Две колонки" });
    expect(split.getAttribute("aria-pressed")).toBe("false");
    await user.click(split);

    expect(screen.getByRole("button", { name: "Две колонки" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Список" }).getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("acpio.gitDiffView.v1")).toBe("split");
  });

  it("reports a file whose diff failed to load", async () => {
    apiMock.gitDiff.mockImplementation((_id: string, path: string) =>
      path === "src/b.ts" ? Promise.reject(new Error("boom")) : Promise.resolve(fileDiff(path, "new")),
    );
    renderViewer();

    await waitFor(() => expect(fileBlock("src/b.ts")?.textContent).toContain("Не удалось загрузить diff"));
  });

  it("closes on the back button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderViewer();

    await user.click(screen.getByRole("button", { name: "Назад" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows one file per screen and pages through the diff in the single-file layout", async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => expect(fileBlock("src/a.ts")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Один файл" }));

    // Only the file on screen is mounted; the rest of the changeset is gone.
    await waitFor(() => expect(fileBlock("src/b.ts")).toBeNull());
    expect(fileBlock("src/a.ts")?.textContent).toContain("new-src/a.ts");

    await user.click(screen.getByRole("button", { name: "Следующий файл" }));
    await waitFor(() => expect(fileBlock("src/b.ts")).toBeTruthy());
    expect(fileBlock("src/a.ts")).toBeNull();
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(localStorage.getItem("acpio.gitDiffLayout.v1")).toBe("single");

    // Back to the stacked list: every file is mounted again.
    await user.click(screen.getByRole("button", { name: "Все файлы" }));
    await waitFor(() => expect(fileBlock("src/a.ts")).toBeTruthy());
    expect(fileBlock("assets/logo.png")).toBeTruthy();
  });
});
