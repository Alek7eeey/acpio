// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppDialog } from "./AppDialog";

afterEach(cleanup);

describe("AppDialog", () => {
  it("renders title, description, children and actions", () => {
    render(
      <AppDialog
        title="Заголовок"
        description="Описание"
        onClose={vi.fn()}
        actions={<button type="button">OK</button>}
      >
        <p>Содержимое</p>
      </AppDialog>,
    );
    expect(screen.getByRole("dialog", { name: "Заголовок" })).toBeTruthy();
    expect(screen.getByText("Описание")).toBeTruthy();
    expect(screen.getByText("Содержимое")).toBeTruthy();
    expect(screen.getByRole("button", { name: "OK" })).toBeTruthy();
  });

  it("renders without the description paragraph when omitted", () => {
    render(<AppDialog title="Заголовок" onClose={vi.fn()} actions={<button type="button">OK</button>} />);
    expect(screen.getByRole("dialog", { name: "Заголовок" })).toBeTruthy();
  });

  it("closes on overlay mousedown when the target is the overlay itself", () => {
    const onClose = vi.fn();
    const { container } = render(
      <AppDialog title="T" onClose={onClose} actions={<button type="button">OK</button>} />,
    );
    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when mousedown lands inside the dialog body", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AppDialog title="T" onClose={onClose} actions={<button type="button">OK</button>}>
        <input placeholder="поле" />
      </AppDialog>,
    );
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(<AppDialog title="T" onClose={onClose} actions={<button type="button">OK</button>} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes the Escape listener when unmounted", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <AppDialog title="T" onClose={onClose} actions={<button type="button">OK</button>} />,
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
