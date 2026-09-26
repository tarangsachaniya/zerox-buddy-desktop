import { EventEmitter } from "node:events";
import WebSocket from "ws";

import { mintWsTicket } from "../auth/api-client";
import { WS_BASE_URL } from "../config";

/**
 * Ticket-handshake WebSocket, copied from priinteve-owner-desktop's
 * ws-client.ts. The server puts this computer in its shop's room only, so
 * every frame means "something changed, refetch the queue". Emits
 * "message" and "status" ("online" | "connecting" | "offline").
 */
export const wsEvents = new EventEmitter();

let active = false;
let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (!active) return;
  attempt += 1;
  wsEvents.emit("status", attempt > 2 ? "offline" : "connecting");
  const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (!active) return;
  let ticket: string;
  try {
    ticket = await mintWsTicket();
  } catch {
    scheduleReconnect();
    return;
  }
  if (!active) return;

  const ws = new WebSocket(`${WS_BASE_URL}/api/ws/connect?ticket=${encodeURIComponent(ticket)}`);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    wsEvents.emit("status", "online");
    // A reconnect may have missed events: refetch.
    wsEvents.emit("message", { type: "RECONNECTED" });
  };
  ws.onmessage = (evt) => {
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(typeof evt.data === "string" ? evt.data : "") as { type?: unknown };
    } catch {
      return;
    }
    if (frame?.type === "PING") {
      ws.send(JSON.stringify({ type: "PONG" }));
      return;
    }
    wsEvents.emit("message", frame);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (active) scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

export function startWsClient(): void {
  if (active) return;
  active = true;
  attempt = 0;
  wsEvents.emit("status", "connecting");
  void connect();
}

export function stopWsClient(): void {
  if (!active) return;
  active = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socket?.close();
  socket = null;
  wsEvents.emit("status", "offline");
}
