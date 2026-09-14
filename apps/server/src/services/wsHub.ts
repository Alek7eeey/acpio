import type { WebSocket } from "ws";
import type { WsServerEvent } from "@acpio/shared";

type Client = {
  socket: WebSocket;
  sessionIds: Set<string>;
  /** Set after each ping, cleared on pong — two misses in a row = corpse. */
  awaitingPong: boolean;
};

const clients = new Set<Client>();

// Browsers answer protocol-level pings on their own; a phone that vanished
// under lock never does. Without this sweep, dead sockets linger in the set
// until TCP gives up minutes later.
const KEEPALIVE_MS = 30_000;

export function addWsClient(socket: WebSocket) {
  const client: Client = { socket, sessionIds: new Set(), awaitingPong: false };
  clients.add(client);
  socket.on("pong", () => {
    client.awaitingPong = false;
  });
  const timer = setInterval(() => {
    if (socket.readyState !== 1) {
      stop();
      return;
    }
    if (client.awaitingPong) {
      socket.terminate();
      stop();
      return;
    }
    client.awaitingPong = true;
    socket.ping();
  }, KEEPALIVE_MS);
  const stop = () => {
    clearInterval(timer);
    clients.delete(client);
  };
  socket.on("close", stop);
  return client;
}

export function subscribeClient(client: Client, sessionId: string) {
  client.sessionIds.add(sessionId);
}

export function unsubscribeClient(client: Client, sessionId: string) {
  client.sessionIds.delete(sessionId);
}

export function broadcast(event: WsServerEvent) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.socket.readyState !== 1) continue;
    try {
      client.socket.send(payload);
    } catch {
      // ignore broken sockets
    }
  }
}

export function broadcastToSession(_sessionId: string, event: WsServerEvent) {
  // Single-user local harness: fan-out to all connected clients.
  broadcast(event);
}
