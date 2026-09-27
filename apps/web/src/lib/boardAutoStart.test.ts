// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A page reload: the module re-reads storage from scratch instead of keeping its state. */
async function loadAfterReload() {
  vi.resetModules();
  return import("./boardAutoStart");
}

beforeEach(() => {
  localStorage.clear();
});

describe("boardAutoStart", () => {
  it("remembers the creation switch across a reload", async () => {
    const page = await loadAfterReload();
    const before = renderHook(() => page.useBoardAutoStart("create"));
    expect(before.result.current).toBe(false);
    act(() => page.toggleBoardAutoStart("create"));
    expect(before.result.current).toBe(true);

    const reloaded = await loadAfterReload();
    const after = renderHook(() => reloaded.useBoardAutoStart("create"));
    expect(after.result.current).toBe(true);
  });

  it("remembers the agent-menu switch across a reload", async () => {
    const page = await loadAfterReload();
    act(() => page.toggleBoardAutoStart("menu"));
    expect(
      renderHook(() => page.useBoardAutoStart("menu")).result.current,
    ).toBe(false);

    const reloaded = await loadAfterReload();
    expect(
      renderHook(() => reloaded.useBoardAutoStart("menu")).result.current,
    ).toBe(false);
  });

  it("starts from the default on a fresh profile", async () => {
    const page = await loadAfterReload();
    act(() => page.toggleBoardAutoStart("create"));
    localStorage.clear();

    const reloaded = await loadAfterReload();
    expect(
      renderHook(() => reloaded.useBoardAutoStart("create")).result.current,
    ).toBe(false);
  });

  it("keeps the two switches independent", async () => {
    const page = await loadAfterReload();
    act(() => page.toggleBoardAutoStart("create"));

    const reloaded = await loadAfterReload();
    expect(
      renderHook(() => reloaded.useBoardAutoStart("create")).result.current,
    ).toBe(true);
    expect(
      renderHook(() => reloaded.useBoardAutoStart("menu")).result.current,
    ).toBe(true);
  });

  it("still flips when localStorage refuses the write", async () => {
    const page = await loadAfterReload();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const hook = renderHook(() => page.useBoardAutoStart("create"));
      act(() => page.toggleBoardAutoStart("create"));
      expect(hook.result.current).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
