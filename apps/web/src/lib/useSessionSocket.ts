import { useEffect, useRef } from "react";
import type { WsClientEvent, WsServerEvent } from "@acprocess/shared";
import { useAppStore } from "./store";

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

let wsSendImpl: ((msg: WsClientEvent) => void) | null = null;

/** Send a client WS event on the shared app socket (no-op if disconnected). */
export function sendWsMessage(msg: WsClientEvent) {
  wsSendImpl?.(msg);
}

export function useSessionSocket(sessionId: string | null, enabled = true) {
  const handleWsEvent = useAppStore((s) => s.handleWsEvent);
  const setConnected = useAppStore((s) => s.setConnected);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const handleWsEventRef = useRef(handleWsEvent);
  handleWsEventRef.current = handleWsEvent;

  // Keep one socket for the app lifetime — reconnecting on every chat switch felt laggy.
  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      socketRef.current?.close();
      socketRef.current = null;
      wsSendImpl = null;
      return;
    }

    let closed = false;
    let retryTimer: number | undefined;

    const subscribe = (socket: WebSocket) => {
      const id = sessionIdRef.current;
      if (!id || socket.readyState !== WebSocket.OPEN) return;
      const msg: WsClientEvent = { type: "subscribe", sessionId: id };
      socket.send(JSON.stringify(msg));
    };

    const connect = () => {
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        if (closed) return;
        setConnected(true);
        wsSendImpl = (msg) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
        };
        subscribe(socket);
      };

      socket.onmessage = (ev) => {
        try {
          const data = JSON.parse(String(ev.data)) as WsServerEvent;
          handleWsEventRef.current(data);
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          wsSendImpl = null;
        }
        setConnected(false);
        if (!closed) {
          retryTimer = window.setTimeout(connect, 1500);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
      wsSendImpl = null;
    };
  }, [enabled, setConnected]);

  // Resubscribe without tearing down the connection.
  useEffect(() => {
    const socket = socketRef.current;
    if (!enabled || !sessionId || !socket || socket.readyState !== WebSocket.OPEN) return;
    const msg: WsClientEvent = { type: "subscribe", sessionId };
    socket.send(JSON.stringify(msg));
  }, [sessionId, enabled]);
}
