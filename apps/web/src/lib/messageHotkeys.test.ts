// @vitest-environment jsdom
// Обычная печать не должна превращаться в команды сообщения. Чат 74dadea4
// набрал «ок» при пустом (расфокусированном) поле ввода, и «к» — это физическая
// KeyR: сработал regenerate по сообщению под указателем, ответ отменился, а
// сообщение читателя помечалось отредактированным. Поэтому буквенная команда
// действует только на первое нажатие после того, как указатель пришёл на
// сообщение: любая другая клавиша означает набор текста, а не команду.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armMessageHotkey,
  installMessageHotkeys,
  registerMessageHotkeys,
  setMessageHotkeyHover,
} from "./messageHotkeys.js";

const run = vi.fn(() => true);
let uninstall: () => void = () => {};

function pressKey(code: string, init: KeyboardEventInit = {}) {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
}

beforeEach(() => {
  run.mockClear();
  setMessageHotkeyHover(null);
  armMessageHotkey(null);
  registerMessageHotkeys({
    id: "m1",
    menuOpen: false,
    has: () => true,
    run,
  });
  uninstall = installMessageHotkeys();
});

afterEach(() => {
  uninstall();
});

describe("message hotkeys", () => {
  it("regenerate fires on the first key after the pointer landed on the message", () => {
    setMessageHotkeyHover("m1");
    pressKey("KeyR");
    expect(run).toHaveBeenCalledWith("regenerate");
  });

  it("a typed word is not a command: the letter pressed after another key does nothing", () => {
    // The pointer rests over the message; the reader types «ок» at a blurred
    // composer. «о» is KeyJ — no command — and it must take the arming with it,
    // or «к» (KeyR) regenerates the answer under the pointer.
    setMessageHotkeyHover("m1");
    pressKey("KeyJ");
    pressKey("KeyR");
    expect(run).not.toHaveBeenCalled();
  });

  it("a click arms the message again, and the next letter is a command", () => {
    setMessageHotkeyHover("m1");
    pressKey("KeyJ");
    armMessageHotkey("m1");
    pressKey("KeyR");
    expect(run).toHaveBeenCalledWith("regenerate");
  });

  it("no command while the pointer is over nothing", () => {
    pressKey("KeyR");
    expect(run).not.toHaveBeenCalled();
  });

  it("no command while a text field has focus", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    setMessageHotkeyHover("m1");
    field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    field.remove();
  });

  it("a modifier makes the key a browser shortcut, not a message command", () => {
    setMessageHotkeyHover("m1");
    pressKey("KeyR", { ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
