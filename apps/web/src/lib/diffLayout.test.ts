// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setDiffLayout, useDiffLayout } from "./diffLayout";

describe("diffLayout", () => {
  beforeEach(() => {
    act(() => setDiffLayout("stacked"));
  });

  it("keeps every mounted stage on the same layout", () => {
    const docked = renderHook(() => useDiffLayout());
    const stage = renderHook(() => useDiffLayout());

    act(() => setDiffLayout("single"));

    expect(docked.result.current).toBe("single");
    expect(stage.result.current).toBe("single");
  });

  it("survives a remount, so opening another diff does not reset the layout", () => {
    act(() => setDiffLayout("single"));
    const first = renderHook(() => useDiffLayout());
    expect(first.result.current).toBe("single");
    first.unmount();

    const second = renderHook(() => useDiffLayout());
    expect(second.result.current).toBe("single");
  });
});
