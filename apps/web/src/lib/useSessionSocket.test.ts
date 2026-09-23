// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useSessionSocket } from "./useSessionSocket";
import { useAppStore } from "./store";

/** Socket double. `close()` deliberately never fires `onclose`: that is how a
 *  half-open pipe behaves after a device sleeps, and the client must not depend
 *  on it to recover. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  /** Answer application pings, i.e. a healthy pipe. */
  answersPings = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
    if (this.answersPings && data.includes('"ping"')) {
      this.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    }
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

function lastSocket() {
  return FakeSocket.instances.at(-1)!;
}

describe("useSessionSocket recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("dials a fresh socket one watchdog later when the live one stops answering", () => {
    renderHook(() => useSessionSocket("s1", true));
    const socket = lastSocket();
    socket.answersPings = true;
    socket.open();

    vi.advanceTimersByTime(21_000);
    expect(FakeSocket.instances.length).toBe(1);

    // The device slept: pings go unanswered, onclose never fires.
    socket.answersPings = false;
    vi.advanceTimersByTime(10_000);

    expect(FakeSocket.instances.length).toBe(2);
    expect(lastSocket().readyState).toBe(FakeSocket.CONNECTING);
  });

  it("keeps a socket that answers its pings when the page becomes visible again", () => {
    renderHook(() => useSessionSocket("s1", true));
    const socket = lastSocket();
    socket.answersPings = true;
    socket.open();

    vi.advanceTimersByTime(26_000);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1_000);

    expect(FakeSocket.instances.length).toBe(1);
    visibility.mockRestore();
  });

  it("dials the socket while the OS reports no internet", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    renderHook(() => useSessionSocket("s1", true));

    // The harness is same-origin and reachable over HTTP even behind a proxy
    // that makes Windows report "no internet" — the dial must still happen.
    expect(FakeSocket.instances.length).toBe(1);
    online.mockRestore();
  });

  it("verifies the pipe on an offline event instead of dropping it", () => {
    renderHook(() => useSessionSocket("s1", true));
    const socket = lastSocket();
    socket.answersPings = true;
    socket.open();
    expect(useAppStore.getState().connection).toBe("open");

    // The OS's internet verdict says nothing about a same-origin socket: keep the
    // pipe, ask it for a pong, and stay open. Dropping it here flashed
    // "Переподключение" every time Windows reported no internet behind the proxy.
    window.dispatchEvent(new Event("offline"));

    expect(FakeSocket.instances.length).toBe(1);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "ping" }));
    expect(useAppStore.getState().connection).toBe("open");

    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("keeps the live socket when a frozen page comes back with a stale reply clock", () => {
    renderHook(() => useSessionSocket("s1", true));
    const socket = lastSocket();
    socket.answersPings = true;
    socket.open();

    // The tab was frozen: no JS ran, so the pongs the network stack answered were
    // never observed here and `lastAliveAt` went stale. The pipe is fine, and the
    // pong to the re-ping proves it — dialing a fresh socket over it flashed
    // "Переподключение" on every return to the tab.
    vi.setSystemTime(new Date(Date.now() + 40_000));
    window.dispatchEvent(new Event("focus"));

    expect(FakeSocket.instances.length).toBe(1);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "ping" }));
    expect(useAppStore.getState().connection).toBe("open");
  });
});
