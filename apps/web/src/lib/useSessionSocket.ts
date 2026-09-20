import { useEffect, useRef } from "react";
import type { WsClientEvent, WsServerEvent } from "@acpio/shared";
import { createTranslator } from "./translator";
import { showToast } from "./toast";
import { dispatchShellConsole } from "./shellConsole";
import { useAppStore } from "./store";

function routeShellConsoleWsEvent(event: WsServerEvent): boolean {
  if (event.type === "process.output" && event.source === "shell") {
    dispatchShellConsole({ type: "output", sessionId: event.sessionId, text: event.text });
    return true;
  }
  if (event.type === "process.cleared") {
    dispatchShellConsole({ type: "cleared", sessionId: event.sessionId });
    return true;
  }
  return false;
}

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

let wsSendImpl: ((msg: WsClientEvent) => void) | null = null;

/** Send a client WS event on the shared app socket (no-op if disconnected). */
export function sendWsMessage(msg: WsClientEvent) {
  wsSendImpl?.(msg);
}

// Mobile OSes drop the TCP pipe while the page is frozen (phone locked) without
// telling the socket: readyState stays OPEN on a corpse, so onclose never fires
// and nothing reconnects. The heartbeat pings on a timer, the tick watchdog
// closes whatever did not answer in time, and poke() re-checks the moment the
// page wakes up or the network comes back.
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** No message for this long (the phone slept) — close without waiting for a pong. */
const STALE_AFTER_MS = 30_000;
const RETRY_MIN_MS = 1_000;
/** Local harness: a restarted server is back within seconds — a 15 s backoff made
 *  reloading the page the faster way to recover. */
const RETRY_MAX_MS = 5_000;
/** Reconnecting faster than this is a blip — resync silently, no toast. */
const RESTORED_TOAST_AFTER_MS = 8_000;

export function useSessionSocket(sessionId: string | null, enabled = true) {
  const handleWsEvent = useAppStore((s) => s.handleWsEvent);
  const setConnection = useAppStore((s) => s.setConnection);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const handleWsEventRef = useRef(handleWsEvent);
  handleWsEventRef.current = handleWsEvent;

  // Keep one socket for the app lifetime — reconnecting on every chat switch felt laggy.
  useEffect(() => {
    if (!enabled) {
      setConnection("offline");
      socketRef.current?.close();
      socketRef.current = null;
      wsSendImpl = null;
      return;
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let retryDelay = RETRY_MIN_MS;
    let everOpen = false;
    let lastAliveAt = 0;
    let lastPingAt = 0;
    let connectStartedAt = 0;

    const clearRetry = () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    const subscribe = (socket: WebSocket) => {
      const id = sessionIdRef.current;
      if (!id || socket.readyState !== WebSocket.OPEN) return;
      const msg: WsClientEvent = { type: "subscribe", sessionId: id };
      socket.send(JSON.stringify(msg));
    };

    const connect = () => {
      if (disposed) return;
      clearRetry();
      if (!navigator.onLine) {
        // Dialing now would just fail. The `online` listener pokes us back, and
        // this timer keeps us from being stranded offline if it never fires.
        setConnection("offline");
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
        return;
      }
      setConnection(everOpen ? "reconnecting" : "connecting");
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;
      connectStartedAt = Date.now();

      socket.onopen = () => {
        if (disposed || socketRef.current !== socket) return;
        const wasReconnect = everOpen;
        const goneFor = wasReconnect && lastAliveAt > 0 ? Date.now() - lastAliveAt : 0;
        everOpen = true;
        retryDelay = RETRY_MIN_MS;
        lastAliveAt = Date.now();
        lastPingAt = 0;
        setConnection("open");
        wsSendImpl = (msg) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
        };
        subscribe(socket);
        if (!wasReconnect) return;
        // Events broadcast while the socket was down are gone for good —
        // re-read what the server owns (list, open chat, parked prompts).
        void useAppStore.getState().resyncAfterReconnect();
        if (goneFor > RESTORED_TOAST_AFTER_MS) {
          const locale = useAppStore.getState().settings.locale ?? "en";
          showToast(createTranslator(locale)("common.connRestored"), { tone: "success" });
        }
      };

      socket.onmessage = (ev) => {
        if (socketRef.current !== socket) return;
        lastAliveAt = Date.now();
        // Traffic proves the pipe is back even without a fresh onopen — the
        // socket can survive a network hop that flagged us offline/reconnecting.
        const state = useAppStore.getState();
        if (state.connection !== "open") state.setConnection("open");
        try {
          const data = JSON.parse(String(ev.data)) as WsServerEvent;
          if (routeShellConsoleWsEvent(data)) return;
          handleWsEventRef.current(data);
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        // A superseded socket must not schedule another connect: after a wake we
        // already dialed a fresh one, and these late closes used to leak pipes.
        if (disposed || socketRef.current !== socket) return;
        socketRef.current = null;
        wsSendImpl = null;
        setConnection(navigator.onLine ? "reconnecting" : "offline");
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
      };
    };

    /**
     * Handlers off, socket abandoned. A half-open pipe on a sleeping tablet
     * answers `close()` slowly (or never), so a wake-up must not wait for its
     * onclose before dialing again.
     */
    const dropSocket = () => {
      const socket = socketRef.current;
      socketRef.current = null;
      wsSendImpl = null;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
    };

    /** Re-dial right now: wake-up, network return, or a dead pipe found mid-tick. */
    const reconnectNow = () => {
      if (disposed) return;
      clearRetry();
      retryDelay = RETRY_MIN_MS;
      dropSocket();
      connect();
    };

    const tick = window.setInterval(() => {
      if (disposed) return;
      const socket = socketRef.current;
      if (!socket) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        if (Date.now() - connectStartedAt > CONNECT_TIMEOUT_MS) reconnectNow();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (lastPingAt > 0 && lastAliveAt < lastPingAt && now - lastPingAt > PONG_TIMEOUT_MS) {
        reconnectNow(); // dead peer — don't wait for its onclose
        return;
      }
      if (now - lastPingAt >= PING_INTERVAL_MS) {
        lastPingAt = now;
        try {
          socket.send(JSON.stringify({ type: "ping" } satisfies WsClientEvent));
        } catch {
          reconnectNow();
        }
      }
    }, 2_000);

    // Phone unlocked, tab re-focused, network back — verify the pipe right now
    // instead of waiting out the heartbeat.
    const poke = () => {
      if (disposed) return;
      const socket = socketRef.current;
      if (
        !socket ||
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) {
        reconnectNow();
        return;
      }
      if (socket.readyState === WebSocket.CONNECTING) {
        if (Date.now() - connectStartedAt > CONNECT_TIMEOUT_MS) reconnectNow();
        return;
      }
      const now = Date.now();
      if (lastAliveAt > 0 && now - lastAliveAt > STALE_AFTER_MS) {
        // The page was frozen — the OS dropped the pipe underneath. A pong can
        // never come, so dial fresh instead of waiting out the watchdog.
        reconnectNow();
        return;
      }
      lastPingAt = now;
      try {
        socket.send(JSON.stringify({ type: "ping" } satisfies WsClientEvent));
      } catch {
        reconnectNow();
      }
      // If the socket survived whatever flagged us offline, the pong lands in
      // onmessage and flips the state back to open.
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") poke();
    };
    const onOffline = () => {
      if (!disposed) setConnection("offline");
    };
    window.addEventListener("focus", poke);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", poke);
    window.addEventListener("offline", onOffline);

    connect();

    return () => {
      disposed = true;
      clearRetry();
      window.clearInterval(tick);
      window.removeEventListener("focus", poke);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", poke);
      window.removeEventListener("offline", onOffline);
      socketRef.current?.close();
      socketRef.current = null;
      wsSendImpl = null;
    };
  }, [enabled, setConnection]);

  // Resubscribe without tearing down the connection.
  useEffect(() => {
    const socket = socketRef.current;
    if (!enabled || !sessionId || !socket || socket.readyState !== WebSocket.OPEN) return;
    const msg: WsClientEvent = { type: "subscribe", sessionId };
    socket.send(JSON.stringify(msg));
  }, [sessionId, enabled]);
}
