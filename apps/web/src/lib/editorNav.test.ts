// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NavHistory, trapBrowserBack } from "./editorNav";

const at = (key: string, line = 1, col = 1) => ({ key, line, col });

describe("editor history: where «назад» goes", () => {
  it("walks back file to file, then forward again", () => {
    const nav = new NavHistory();
    nav.push(at("file:a.ts"));
    nav.push(at("file:b.ts", 40));
    expect(nav.step(-1)).toEqual(at("file:a.ts"));
    expect(nav.step(1)).toEqual(at("file:b.ts", 40));
    expect(nav.step(1)).toBeNull();
  });

  it("forgets what was ahead once the reader goes somewhere new", () => {
    const nav = new NavHistory();
    nav.push(at("file:a.ts"));
    nav.push(at("file:b.ts"));
    nav.step(-1);
    nav.push(at("file:c.ts"));
    expect(nav.step(1)).toBeNull();
    expect(nav.step(-1)).toEqual(at("file:a.ts"));
  });

  it("stays put when the same place is asked for twice", () => {
    const nav = new NavHistory();
    nav.push(at("file:a.ts", 3, 2));
    nav.push(at("file:a.ts", 3, 2));
    expect(nav.canBack).toBe(false);
  });

  it("skips a place whose tab was closed", () => {
    const nav = new NavHistory();
    nav.push(at("file:a.ts"));
    nav.push(at("file:b.ts"));
    nav.push(at("file:c.ts"));
    const gone = nav.step(-1, (step) => step.key !== "file:b.ts");
    expect(gone).toEqual(at("file:a.ts"));
  });
});

describe("browser back trap", () => {
  it("arms one extra entry and stops listening when released", () => {
    const before = history.length;
    const release = trapBrowserBack(() => true);
    expect(history.length).toBe(before + 1);
    expect((history.state as Record<string, unknown>).__acpioEditorNav).toBe(true);
    release();
  });

  it("turns a back press into a step of the editor, not a page change", () => {
    const step = vi.fn(() => true);
    const release = trapBrowserBack(step);
    const before = history.length;
    // What the browser fires when the trap entry is popped: no mark in its state.
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(step).toHaveBeenCalledWith(-1);
    expect(history.length).toBe(before + 1);
    release();
  });

  it("lets the press leave once the editor has nowhere to go", () => {
    const leave = vi.spyOn(history, "back").mockImplementation(() => {});
    const step = vi.fn(() => false);
    const release = trapBrowserBack(step);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(leave).toHaveBeenCalledTimes(1);
    release();
    leave.mockRestore();
  });

  it("reads a press that came from ahead as forward", () => {
    const step = vi.fn(() => true);
    const release = trapBrowserBack(step);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: { __acpioEditorNav: true } }),
    );
    expect(step).toHaveBeenCalledWith(1);
    release();
  });
});
