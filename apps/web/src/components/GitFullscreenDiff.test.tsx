// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { GitFullscreenDiff } from "./GitFullscreenDiff";

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

function renderViewer(paths: string[] = SMALL, props: Partial<Parameters<typeof GitFullscreenDiff>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <I18nProvider>
      <GitFullscreenDiff
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

describe("GitFullscreenDiff", () => {
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

  it("keeps the reader's file when the file list is refreshed", async () => {
    const user = userEvent.setup();
    const viewerProps: Partial<Parameters<typeof GitFullscreenDiff>[0]> = {
      sessionId: "s1",
      scope: { mode: "working" },
      initialPath: "src/a.ts",
      onClose: () => {},
    };
    const { rerender } = render(
      <I18nProvider>
        <GitFullscreenDiff {...viewerProps} files={SMALL.map((path) => ({ path, badge: "M" }))} />
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
        <GitFullscreenDiff
          {...viewerProps}
          files={[...SMALL, "src/c.ts"].map((path) => ({ path, badge: "M" }))}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("3 / 4")).toBeTruthy());
  });

  it("switches the diff between unified and split from the top bar", async () => {
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

    await user.click(screen.getByRole("button", { name: "Закрыть полноэкранный diff" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
