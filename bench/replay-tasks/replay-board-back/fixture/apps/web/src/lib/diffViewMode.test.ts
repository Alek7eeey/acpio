// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setDiffViewMode, useDiffViewMode } from "./diffViewMode";

describe("diffViewMode", () => {
  beforeEach(() => {
    act(() => setDiffViewMode("unified"));
  });

  it("keeps every mounted diff on the same mode", () => {
    const docked = renderHook(() => useDiffViewMode());
    const stage = renderHook(() => useDiffViewMode());

    act(() => setDiffViewMode("split"));

    expect(docked.result.current).toBe("split");
    expect(stage.result.current).toBe("split");
  });

  it("survives a remount, so opening another diff does not reset the mode", () => {
    act(() => setDiffViewMode("split"));
    const first = renderHook(() => useDiffViewMode());
    expect(first.result.current).toBe("split");
    first.unmount();

    const second = renderHook(() => useDiffViewMode());
    expect(second.result.current).toBe("split");
  });
});
