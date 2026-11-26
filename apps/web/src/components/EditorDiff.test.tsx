// @vitest-environment jsdom
// The git panel reads a change with the code pane's own diff: both sides come
// from the server (the revision git holds, the file as it is on disk), and the
// layout is the reader's own — the same preference the editor's diff tab uses.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";

const apiMock = vi.hoisted(() => ({ gitFileText: vi.fn() }));
vi.mock("../lib/api", () => ({ api: apiMock }));

const fileMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/editorApi", () => ({ editorApi: { file: fileMock } }));

import { EditorDiff, forgetDiffs } from "./EditorDiff";

const PATH = "src/a.ts";

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru", editorTheme: "dark" } }));
  localStorage.clear();
  // The component remembers what it read; every test starts with an empty one.
  forgetDiffs();
  apiMock.gitFileText.mockResolvedValue({ text: "const a = 1;\n", exists: true });
  fileMock.mockResolvedValue({ path: PATH, text: "const a = 2;\n" });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderDiff(props: Partial<Parameters<typeof EditorDiff>[0]> = {}) {
  return render(
    <I18nProvider>
      <EditorDiff sessionId="s1" root="C:/repo" path={PATH} {...props} />
    </I18nProvider>,
  );
}

describe("EditorDiff", () => {
  it("reads both sides and shows them in the editor's diff", async () => {
    const { container } = renderDiff();

    await waitFor(() => expect(apiMock.gitFileText).toHaveBeenCalledWith("s1", PATH));
    expect(fileMock).toHaveBeenCalledWith("C:/repo", PATH);
    // The two sides are the revision and the working copy, in one merge view.
    await waitFor(() => expect(container.querySelector(".cm-mergeView")).toBeTruthy());
    const text = container.textContent ?? "";
    expect(text).toContain("const a = 1;");
    expect(text).toContain("const a = 2;");
  });

  it("switches between the two columns and one, and remembers the choice", async () => {
    const user = userEvent.setup();
    const { container } = renderDiff();
    await waitFor(() => expect(container.querySelector(".cm-mergeView")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Одна колонка — изменения внутри текста" }));

    // Inline: one editor, the deletions inside the text.
    await waitFor(() => expect(container.querySelector(".cm-mergeView")).toBeNull());
    expect(localStorage.getItem("acpio.diffMode.v1")).toBe("inline");

    await user.click(screen.getByRole("button", { name: "Две колонки — было и стало" }));
    await waitFor(() => expect(container.querySelector(".cm-mergeView")).toBeTruthy());
    expect(localStorage.getItem("acpio.diffMode.v1")).toBe("split");
  });

  it("takes a deleted file's empty working copy", async () => {
    fileMock.mockRejectedValue(new Error("ENOENT"));
    const { container } = renderDiff({ deleted: true });

    await waitFor(() => expect(apiMock.gitFileText).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".cm-mergeView")).toBeTruthy());
    expect(container.textContent).toContain("const a = 1;");
  });

  it("says so when the file cannot be read", async () => {
    fileMock.mockRejectedValue(new Error("ENOENT"));

    renderDiff();

    expect(await screen.findByText("Не удалось загрузить diff")).toBeTruthy();
  });

  it("reads a file once, however often the reader comes back to it", async () => {
    const first = renderDiff();
    await waitFor(() => expect(document.querySelector(".cm-mergeView")).toBeTruthy());
    first.unmount();

    // Looking at another file and coming back is the normal way of reading a
    // changeset: neither side is fetched again for the same numbers.
    const second = renderDiff();
    await waitFor(() => expect(document.querySelector(".cm-mergeView")).toBeTruthy());
    expect(apiMock.gitFileText).toHaveBeenCalledTimes(1);
    expect(fileMock).toHaveBeenCalledTimes(1);
    second.unmount();

    // The file changed (new line counts in git): read it again.
    renderDiff({ signature: "MM:9:1:0" });
    await waitFor(() => expect(apiMock.gitFileText).toHaveBeenCalledTimes(2));
  });

  it("folds the unchanged stretch into a band that opens it whole", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    apiMock.gitFileText.mockResolvedValue({ text: long, exists: true });
    fileMock.mockResolvedValue({ path: PATH, text: long.replace("line 3", "line three") });
    const user = userEvent.setup();
    const { container } = renderDiff();

    // One change near the top, 57 unchanged lines under it: a diff shows the
    // change and its context, not the whole file.
    const band = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(".cm-diffGap");
      expect(node).toBeTruthy();
      return node!;
    });
    const label = band.getAttribute("aria-label") ?? "";
    expect(Number(label.split(": ")[1])).toBeGreaterThan(40);
    // The change is near the top and the band runs to the end of the file: the
    // hidden lines are all below it, so it points down alone.
    expect(band.querySelector("svg")).toBeTruthy();
    expect(band.dataset.arrows).toBe("down");

    // Both columns carry the band; one click opens the gap in both.
    await user.click(screen.getAllByRole("button", { name: label })[0]!);
    await waitFor(() => expect(container.querySelector(".cm-diffGap")).toBeNull());
  });

  it("points the band one way at a file edge and both ways in between", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const text = [...lines];
    text[9] = "line ten";
    text[24] = "line twenty-five";
    apiMock.gitFileText.mockResolvedValue({ text: lines.join("\n"), exists: true });
    fileMock.mockResolvedValue({ path: PATH, text: text.join("\n") });
    const { container } = renderDiff();

    const arrows = await waitFor(() => {
      const bands = [...container.querySelectorAll<HTMLElement>(".cm-diffGap")];
      expect(bands.length).toBeGreaterThanOrEqual(3);
      return bands.map((band) => band.dataset.arrows);
    });
    // Top of the file, between the two changes, end of the file.
    expect(arrows.slice(0, 3)).toEqual(["up", "both", "down"]);
  });

  it("gives the two columns a divider, and none in one column", async () => {
    const split = renderDiff();
    await waitFor(() => expect(split.container.querySelector(".cm-mergeView")).toBeTruthy());
    expect(split.container.querySelector("[data-diff-splitter]")).toBeTruthy();
    split.unmount();

    const user = userEvent.setup();
    const inline = render(
      <I18nProvider>
        <EditorDiff sessionId="s2" root="C:/repo" path={PATH} />
      </I18nProvider>,
    );
    await waitFor(() => expect(inline.container.querySelector(".cm-mergeView")).toBeTruthy());
    await user.click(within(inline.container).getByRole("button", { name: "Одна колонка — изменения внутри текста" }));
    await waitFor(() => expect(inline.container.querySelector(".cm-mergeView")).toBeNull());
    expect(inline.container.querySelector("[data-diff-splitter]")).toBeNull();
  });

  it("names the pane's size limit instead of a plain failure", async () => {
    fileMock.mockRejectedValue(new Error("file too large"));

    renderDiff();

    expect(await screen.findByText("Файл слишком велик для diff")).toBeTruthy();
  });
});
