// @vitest-environment jsdom
// A changed file with no text to diff is read as what it is: a picture beside
// the picture it replaces, a video with its player, a Word document as itself.
// The sides come from the git panel's own byte route, which the fetch stub
// answers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";

/**
 * The office readers are chunks of their own: the document and the deck are
 * drawn into the host element, and the tests only need to know they were asked
 * for and which host they got.
 */
const docxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/docxPreview", () => ({ renderDocx: docxMock }));
const pptxMock = vi.hoisted(() => vi.fn(async () => ({ destroy: vi.fn() })));
vi.mock("../lib/pptxPreview", () => ({
  renderPptx: pptxMock,
  SLIDE_WIDTH: 960,
  SLIDE_HEIGHT: 540,
}));
const odtMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/odtPreview", () => ({ renderOdt: odtMock }));
const xlsxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/xlsxPreview", () => ({ renderXlsx: xlsxMock }));
const legacyMock = vi.hoisted(() => ({
  docText: vi.fn(() => "Министерство образования"),
  pptText: vi.fn(() => "A Maintenance Program for a bus fleet"),
}));
vi.mock("../lib/legacyOffice", () => ({
  docText: legacyMock.docText,
  pptText: legacyMock.pptText,
}));

import { MediaDiff } from "./MediaDiff";

type Info = { exists: boolean; size: number; mime: string | null };

/** What the byte route answers from: one entry per side of the change. */
let blobInfo: (url: string) => Info = () => ({ exists: true, size: 2048, mime: "image/png" });
const fetchMock = vi.fn(async (url: string) => {
  void url;
  return { ok: true, json: async () => blobInfo(String(url)), arrayBuffer: async () => new ArrayBuffer(8) };
});

beforeEach(() => {
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
  blobInfo = () => ({ exists: true, size: 2048, mime: "image/png" });
  fetchMock.mockClear();
  docxMock.mockClear();
  pptxMock.mockClear();
  odtMock.mockClear();
  xlsxMock.mockClear();
  legacyMock.docText.mockClear();
  legacyMock.pptText.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDiff(props: Partial<Parameters<typeof MediaDiff>[0]> = {}) {
  return render(
    <I18nProvider>
      <MediaDiff sessionId="s1" root="C:/repo" path="assets/logo.png" {...props} />
    </I18nProvider>,
  );
}

/** The URL of one side as the browser would fetch it: `rev` null is the copy on disk. */
function sideUrl(rev: string | null) {
  const url = `/api/sessions/s1/git/blob?path=assets%2Flogo.png${rev ? `&rev=${rev}` : ""}`;
  return url;
}

describe("MediaDiff", () => {
  it("shows a picture beside the picture it replaces", async () => {
    const { container } = renderDiff();

    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources[0]).toBe(sideUrl("HEAD"));
    expect(sources[1]).toContain("path=assets%2Flogo.png");
    expect(sources[1]).not.toContain("rev=");
    expect(container.textContent).toContain("Было");
    expect(container.textContent).toContain("Стало");
  });

  it("shows a new file as one column of itself", async () => {
    blobInfo = (url) => ({ exists: !url.includes("rev=HEAD"), size: 2048, mime: "image/png" });

    const { container } = renderDiff();

    // The revision holds nothing: one picture, one caption, no empty half.
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(1));
    expect(screen.queryByText("Файла нет в этой версии")).toBeNull();
    expect(container.querySelector("figure")?.textContent).toContain("Стало");
    expect(container.querySelector("[data-sides]")?.getAttribute("data-sides")).toBe("1");
  });

  it("reads a commit between the two revisions it carries", async () => {
    const { container } = renderDiff({
      path: "assets/logo.png",
      compare: { from: "parent1", to: "commit2" },
    });

    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources[0]).toContain("rev=parent1");
    expect(sources[1]).toContain("rev=commit2");
  });

  it("gives a video its player", async () => {
    blobInfo = (url) => ({ exists: true, size: 5_000_000, mime: "video/mp4" });

    const { container } = renderDiff({ path: "shot.mp4" });

    await waitFor(() => expect(container.querySelectorAll("video")).toHaveLength(2));
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws a Word document by its own reader", async () => {
    blobInfo = (url) => ({ exists: true, size: 40_960, mime: null });

    const { container } = renderDiff({ path: "docs/spec.docx" });

    // Two sides, each drawn by the reader rather than handed over as a file.
    await waitFor(() => expect(docxMock).toHaveBeenCalledTimes(2));
    expect(container.querySelectorAll('[data-office-preview="docx"]')).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Скачать" })).toBeNull();
  });

  it("draws a presentation slide by slide", async () => {
    blobInfo = (url) => ({ exists: true, size: 90_000, mime: null });

    const { container } = renderDiff({ path: "deck/kickoff.pptx" });

    await waitFor(() => expect(pptxMock).toHaveBeenCalledTimes(2));
    expect(container.querySelectorAll('[data-office-preview="pptx"]')).toHaveLength(2);
    expect(docxMock).not.toHaveBeenCalled();
  });

  it("draws a spreadsheet as a grid", async () => {
    blobInfo = (url) => ({ exists: true, size: 12_000, mime: null });

    const { container } = renderDiff({ path: "docs/plan.xlsx" });

    await waitFor(() => expect(xlsxMock).toHaveBeenCalledTimes(2));
    expect(container.querySelectorAll('[data-office-preview="xlsx"]')).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Скачать" })).toBeNull();
  });

  it("draws an OpenDocument text with its own styles", async () => {
    blobInfo = (url) => ({ exists: true, size: 4000, mime: null });

    const { container } = renderDiff({ path: "docs/spec.odt" });

    await waitFor(() => expect(odtMock).toHaveBeenCalledTimes(2));
    expect(container.querySelectorAll('[data-office-preview="odt"]')).toHaveLength(2);
  });

  it("reads the text of a binary .doc and says the layout is not drawn", async () => {
    blobInfo = (url) => ({ exists: true, size: 32_768, mime: null });

    const { container } = renderDiff({ path: "docs/legacy.doc" });

    await waitFor(() => expect(screen.getAllByText(/Министерство образования/)).toHaveLength(2));
    expect(container.querySelectorAll('[data-office-preview="doc"]')).toHaveLength(2);
    expect(screen.getAllByText("Показан только текст: формат не раскладывается в браузере")).toHaveLength(2);
    expect(legacyMock.docText).toHaveBeenCalledTimes(2);
  });

  it("reads the text of a binary .ppt slide by slide", async () => {
    blobInfo = (url) => ({ exists: true, size: 1_100_000, mime: null });

    const { container } = renderDiff({ path: "deck/legacy.ppt" });

    await waitFor(() => expect(screen.getAllByText(/A Maintenance Program/)).toHaveLength(2));
    expect(legacyMock.pptText).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('[data-office-preview="ppt"]')).toHaveLength(2);
  });

  it("hands over a format the browser does not draw", async () => {
    blobInfo = (url) => ({ exists: true, size: 40_960, mime: null });

    const { container } = renderDiff({ path: "report.zip" });

    await waitFor(() => expect(screen.getAllByText("Браузер этот формат не показывает")).toHaveLength(2));
    expect(container.querySelector("img")).toBeNull();
    // Both sides can still be taken out of the panel, and the size is read off
    // the byte route rather than guessed.
    expect(screen.getAllByRole("link", { name: "Скачать" })).toHaveLength(2);
    expect(container.textContent).toContain("40 KB");
  });

  it("says so when the sides cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, statusText: "Not found", json: async () => ({}) })),
    );

    renderDiff();

    expect(await screen.findByText("Не удалось загрузить diff")).toBeTruthy();
  });
});
