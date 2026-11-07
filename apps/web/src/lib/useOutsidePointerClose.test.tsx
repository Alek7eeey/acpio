// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useOutsidePointerClose } from "./useOutsidePointerClose";

function Popup({ onClose }: { onClose: () => void }) {
  useOutsidePointerClose(true, onClose);
  return (
    <div>
      <div role="menu">
        <button type="button">Показать файл в дереве</button>
      </div>
      <button type="button">снаружи</button>
    </div>
  );
}

describe("useOutsidePointerClose", () => {
  afterEach(() => cleanup());

  it("keeps a menu open while a pointer press lands inside it", () => {
    const onClose = vi.fn();
    const { getByText } = render(<Popup onClose={onClose} />);
    // This is the press that used to unmount the menu and swallow its click.
    fireEvent.pointerDown(getByText("Показать файл в дереве"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a press anywhere else", () => {
    const onClose = vi.fn();
    const { getByText } = render(<Popup onClose={onClose} />);
    fireEvent.pointerDown(getByText("снаружи"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
