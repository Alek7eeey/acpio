import { useEffect } from "react";
import type { WsClientEvent, WsServerEvent } from "@acprocess/shared";
import { useAppStore } from "./store";

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function useSessionSocket(sessionId: string | null, enabled = true) {
  const handleWsEvent = useAppStore((s) => s.handleWsEvent);
  const setConnected = useAppStore((s) => s.setConnected);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | undefined;

    const connect = () => {
      socket = new WebSocket(wsUrl());

      socket.onopen = () => {
        setConnected(true);
        if (sessionId) {
          const msg: WsClientEvent = { type: "subscribe", sessionId };
          socket?.send(JSON.stringify(msg));
        }
      };

      socket.onmessage = (ev) => {
        try {
          const data = JSON.parse(String(ev.data)) as WsServerEvent;
          handleWsEvent(data);
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
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
      socket?.close();
    };
  }, [sessionId, handleWsEvent, setConnected, enabled]);
}
