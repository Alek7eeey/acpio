// @vitest-environment jsdom
// The two variants of a folder picker: a click is the OS dialog (the server
// process opens it on its own screen — the reader's, as long as the page came
// from that machine) and a right click is the app's own browser. On a phone
// both gestures are the app's browser: the OS dialog belongs to another
// machine's screen there, and a click that opens nothing usable is worse than
// the browser that lives in the page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { api } from "../lib/api";
import { FolderPickButton } from "./FolderPickButton";

vi.mock("../lib/api", () => ({
  api: {
    pickDirectory: vi.fn(),
    browseDirectory: vi.fn(),
    createFolder: vi.fn(),
  },
}));

let touch = false;
vi.mock("../lib/pointerUi", () => ({ isTouchUi: () => touch }));

const pickDirectory = vi.mocked(api.pickDirectory);
const browseDirectory = vi.mocked(api.browseDirectory);

function renderButton(onPick = vi.fn()) {
  render(
    <I18nProvider>
      <FolderPickButton className="pick" value="/projects/app" onPick={onPick} />
    </I18nProvider>,
  );
  // The catalog is the store's own (English by default); the caption is the
  // section's "select folder", and nothing else is a button here.
  return { onPick, button: screen.getByRole("button") };
}

beforeEach(() => {
  // jsdom has no element scrolling, and the folder browser scrolls its list to
  // the top in a frame after every answer.
  Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];
  touch = false;
  pickDirectory.mockReset().mockResolvedValue({ path: "/projects/app/docs/attachments" });
  browseDirectory.mockReset().mockResolvedValue({
    path: "/projects/app",
    parent: null,
    entries: [],
  });
});

afterEach(() => cleanup());

describe("FolderPickButton", () => {
  it("opens the OS dialog on a click and hands its answer back", async () => {
    const { onPick, button } = renderButton();
    fireEvent.click(button);

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/projects/app/docs/attachments"));
    expect(pickDirectory).toHaveBeenCalledWith("/projects/app");
    // The app's browser never opened: one gesture, one dialog.
    expect(browseDirectory).not.toHaveBeenCalled();
  });

  it("opens the app's browser on a right click", async () => {
    const { button } = renderButton();
    fireEvent.contextMenu(button);

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  // A phone (coarse pointer) gets the picker that can actually be used: the OS
  // dialog would be on the server's screen.
  it("gives a touch device the app's browser on a plain click too", async () => {
    touch = true;
    const { button } = renderButton();
    fireEvent.click(button);

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  // A server with no dialog to open (headless, or Linux without zenity).
  it("falls back to the app's browser when no OS dialog answers", async () => {
    pickDirectory.mockRejectedValue(new Error("Не найден zenity/kdialog"));
    const { button } = renderButton();
    fireEvent.click(button);

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
  });
});
