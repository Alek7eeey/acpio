// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { MarkdownContent } from "./MarkdownContent";

afterEach(cleanup);

function renderMarkdown(text: string, sessionId: string | null = "s1") {
  return render(
    <I18nProvider>
      <MarkdownContent text={text} sessionId={sessionId} />
    </I18nProvider>,
  );
}

function imageSrcs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
}

function fileUrl(path: string): string {
  return `/api/sessions/s1/file?path=${encodeURIComponent(path)}&inline=1`;
}

// A picture the agent made is a file on this machine, so the markdown source is
// a path — the shape the default URL transform drops before a renderer sees it.
describe("a picture in agent markdown", () => {
  it("serves a path relative to the chat folder through the session file route", () => {
    const { container } = renderMarkdown("Смотри: ![shot](shots/screen.png)");

    expect(imageSrcs(container)).toEqual([fileUrl("shots/screen.png")]);
  });

  it("serves a Windows path a drive letter cannot make look like a URL scheme", () => {
    const { container } = renderMarkdown("![shot](C:\\Users\\me\\shot.png)");

    expect(imageSrcs(container)).toEqual([fileUrl("C:\\Users\\me\\shot.png")]);
  });

  it("turns a file:// link into the same served path", () => {
    const { container } = renderMarkdown("![shot](file:///C:/tmp/shot.png)");

    expect(imageSrcs(container)).toEqual([fileUrl("C:/tmp/shot.png")]);
  });

  it("keeps a remote image and an inline data image as they are", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = renderMarkdown(`![a](https://example.com/a.png)\n\n![b](${data})`);

    expect(imageSrcs(container)).toEqual(["https://example.com/a.png", data]);
  });

  // The source is chosen by the chat, never by the text: a scheme that is not an
  // image the browser may fetch shows its caption instead of becoming an element.
  it("renders no image for a source that is not a picture", () => {
    const { container } = renderMarkdown("![boo](javascript:alert(1))");

    expect(imageSrcs(container)).toEqual([]);
    expect(container.textContent).toContain("boo");
  });

  it("falls back to the caption when there is no chat to resolve a path against", () => {
    const { container } = renderMarkdown("![shot](shots/screen.png)", null);

    expect(imageSrcs(container)).toEqual([]);
    expect(container.textContent).toContain("shot");
  });
});
