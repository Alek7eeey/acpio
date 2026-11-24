// @vitest-environment jsdom
// The one pick control: a click is the OS dialog (the server process opens it
// on its own screen — the reader's, as long as the page came from that
// machine) and a right click is the app's own browser. On a phone both
// gestures are the app's browser: the OS dialog belongs to another machine's
// screen there, and a click that opens nothing usable is worse than the
// browser that lives in the page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { api } from "../lib/api";
import { PathPickField, PickButton } from "./PathPickField";

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

const renderInProvider = (ui: React.ReactNode) =>
  render(<I18nProvider>{ui}</I18nProvider>);

/** The row of a settings field: the value, the pick button, the reset button. */
function renderField(value: string, onPick = vi.fn(), onReset = vi.fn()) {
  renderInProvider(
    <PathPickField
      value={value}
      onPick={onPick}
      onReset={onReset}
      placeholder="/default"
      buttonClassName="btn"
    />,
  );
  return { onPick, onReset };
}

/** jsdom has no element scrolling, and a folder browser scrolls its list. */
beforeEach(() => {
  Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];
  touch = false;
  pickDirectory.mockReset().mockResolvedValue({ path: "/picked" });
  browseDirectory.mockReset().mockResolvedValue({
    path: "/projects/app",
    parent: null,
    entries: [],
  });
});

afterEach(() => cleanup());

describe("PathPickField", () => {
  it("opens the OS dialog on a click and hands its answer to the row", async () => {
    const { onPick } = renderField("/projects/app");
    fireEvent.click(screen.getByRole("button", { name: "Select folder…" }));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("/picked"));
    expect(pickDirectory).toHaveBeenCalledWith("/projects/app");
    // One gesture, one dialog: the app's browser never opened.
    expect(browseDirectory).not.toHaveBeenCalled();
  });

  it("opens the app's browser on a right click", async () => {
    renderField("/projects/app");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select folder…" }));

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  // A phone (coarse pointer) gets the picker that can actually be used: the OS
  // dialog would be on the server's screen.
  it("gives a touch device the app's browser on a plain click too", async () => {
    touch = true;
    renderField("/projects/app");
    fireEvent.click(screen.getByRole("button", { name: "Select folder…" }));

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  // A server with no dialog to open (headless, or Linux without zenity).
  it("falls back to the app's browser when no OS dialog answers", async () => {
    pickDirectory.mockRejectedValue(new Error("Не найден zenity/kdialog"));
    renderField("/projects/app");
    fireEvent.click(screen.getByRole("button", { name: "Select folder…" }));

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
  });

  // A path is chosen, not typed: the value is a read-only box (an input here
  // was autofilled with a provider endpoint and submitted the form on Enter),
  // and the only writes are the two dialogs and the reset.
  it("shows the value read-only, with no text field to type into", () => {
    const { container } = renderInProvider(
      <PathPickField
        value="E:/share/acpio/docs/attachments"
        onPick={vi.fn()}
        onReset={vi.fn()}
        placeholder="/default"
        buttonClassName="btn"
      />,
    );
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByTitle("E:/share/acpio/docs/attachments")).toBeTruthy();
  });

  it("says what an empty value means and resets to it", () => {
    const { onReset } = renderField("E:/shots");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalled();
  });

  it("paints the default's own words while nothing is chosen", () => {
    const { container } = renderInProvider(
      <PathPickField value="" onPick={vi.fn()} onReset={vi.fn()} placeholder="/default" buttonClassName="btn" />,
    );
    expect(container.textContent).toContain("/default");
    // Nothing to reset: the field is already at its default.
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });
});

describe("PickButton (a file)", () => {
  it("hands the page's own file dialog's answer to the caller", () => {
    const onPickFile = vi.fn();
    const { container } = renderInProvider(
      <PickButton
        kind="file"
        accept="application/json,.json"
        className="btn"
        onPickFile={onPickFile}
        onPick={vi.fn()}
      />,
    );
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.accept).toBe("application/json,.json");

    const file = new File(["{}"], "acpio-settings.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onPickFile).toHaveBeenCalledWith(file);
  });

  it("opens the app's browser on a right click and returns a server path", async () => {
    const onPick = vi.fn();
    renderInProvider(<PickButton kind="file" className="btn" onPick={onPick} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Choose file…" }));

    await waitFor(() => expect(browseDirectory).toHaveBeenCalled());
    expect(browseDirectory.mock.calls[0]?.[1]).toEqual({ files: true });
  });
});
