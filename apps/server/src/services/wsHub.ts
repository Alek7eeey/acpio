import type { WebSocket } from "ws";
import type { WsServerEvent } from "@acprocess/shared";

type Client = {
  socket: WebSocket;
  sessionIds: Set<string>;
};

const clients = new Set<Client>();

export function addWsClient(socket: WebSocket) {
  const client: Client = { socket, sessionIds: new Set() };
  clients.add(client);
  socket.on("close", () => clients.delete(client));
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
