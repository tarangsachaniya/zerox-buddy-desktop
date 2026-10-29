import { EventEmitter } from "node:events";
import WebSocket from "ws";

import type { Connection, ConnectionReason } from "../../shared/types";
import { ApiError, mintWsTicket } from "../auth/api-client";
import { WS_BASE_URL } from "../config";
import { log } from "../log";

/**
 * Ticket-handshake WebSocket, first copied from priinteve-owner-desktop's
 * ws-client.ts. The server puts this computer in its shop's room only, so
 * every frame means "something changed, refetch the queue". Emits "message",
 * and "status" with { connection, reason }.
 *
 * Why it's written the way it is (each of these once left the app showing
 * "Offline" until it was restarted):
 *
 *   refused handshake  With an "unexpected-response" listener, `ws` neither
 *                      aborts the request nor fires close/error, so a 401,
 *                      429 or a 502 during a deploy left the socket
 *                      CONNECTING forever. The listener now tears it down and
 *                      schedules the next try itself.
 *   half-open socket   After sleep or a Wi-Fi change a socket can look open
 *                      while nothing arrives. The server pings every 25 s; if
 *                      no frame comes for WATCHDOG_MS, the socket is dropped.
 *   duplicate loops    Every connect() takes a new generation number;
 *                      callbacks and ticket requests from an older one do
 *                      nothing, and only one reconnect timer ever exists.
 *   sleep / resume     resumeWsClient() (wired to powerMonitor in index.ts)
 *                      reconnects at once instead of after a long backoff.
 */
export const wsEvents = new EventEmitter();

const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The server pings every 25 s (WS_HEARTBEAT_INTERVAL_MS); two missed pings and a bit. */
const WATCHDOG_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

let active = false;
let generation = 0;
let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;

/** For the diagnostics panel. */
export const wsStats = { lastFrameAt: null as string | null, reconnects: 0, lastReason: null as ConnectionReason | null };

function emitStatus(connection: Connection, reason: ConnectionReason | null = null): void {
  wsStats.lastReason = reason;
  wsEvents.emit("status", { connection, reason });
}

function clearTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdog) clearTimeout(watchdog);
  reconnectTimer = null;
  watchdog = null;
}

/** Drops the current socket without letting its callbacks schedule anything. */
function dropSocket(): void {
  const ws = socket;
  socket = null;
  if (!ws) return;
  ws.removeAllListeners();
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  // Swallow the error terminate() can raise on a socket that never opened.
  ws.on("error", () => {});
  try {
    ws.terminate();
  } catch {
    // already gone
  }
}

/** Full jitter: anywhere from 0 to the exponential cap, so many shops don't reconnect in step after a deploy. */
export function backoffDelay(n: number, random = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(n, 10));
  return Math.max(500, Math.round(cap * random()));
}

function scheduleReconnect(gen: number, reason: ConnectionReason): void {
  if (!active || gen !== generation) return;
  dropSocket();
  clearTimers();
  attempt += 1;
  wsStats.reconnects += 1;
  // A blip shows "Reconnecting"; a few failures in a row is really offline.
  emitStatus(attempt > 3 ? "offline" : "reconnecting", reason);
  const delay = backoffDelay(attempt);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function armWatchdog(gen: number): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (gen !== generation) return;
    log.warn(`[ws] nothing from the server for ${WATCHDOG_MS / 1000}s, reconnecting`);
    scheduleReconnect(gen, "network");
  }, WATCHDOG_MS);
}

function reasonFor(err: unknown): ConnectionReason {
  if (err instanceof ApiError) {
    if (err.status === 0) return "network";
    if (err.status === 401 || err.status === 403) return "auth";
    return "server";
  }
  return "network";
}

async function connect(): Promise<void> {
  if (!active) return;
  clearTimers();
  dropSocket();
  const gen = ++generation;

  let ticket: string;
  try {
    ticket = await mintWsTicket();
  } catch (err) {
    if (gen !== generation) return;
    log.warn("[ws] couldn't get a connection ticket", err instanceof Error ? err.message : err);
    // A real sign-out is handled by the processor's 401 path; keep retrying until then.
    scheduleReconnect(gen, reasonFor(err));
    return;
  }
  if (!active || gen !== generation) return;

  const ws = new WebSocket(`${WS_BASE_URL}/api/ws/connect?ticket=${encodeURIComponent(ticket)}`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  socket = ws;

  ws.onopen = () => {
    if (gen !== generation) return;
    attempt = 0;
    wsStats.lastFrameAt = new Date().toISOString();
    armWatchdog(gen);
    emitStatus("online");
    // A reconnect may have missed events: refetch.
    wsEvents.emit("message", { type: "RECONNECTED" });
  };
  ws.onmessage = (evt) => {
    if (gen !== generation) return;
    wsStats.lastFrameAt = new Date().toISOString();
    armWatchdog(gen);
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(typeof evt.data === "string" ? evt.data : "") as { type?: unknown };
    } catch {
      return;
    }
    if (frame?.type === "PING") {
      try {
        ws.send(JSON.stringify({ type: "PONG" }));
      } catch {
        // the close handler deals with it
      }
      return;
    }
    wsEvents.emit("message", frame);
  };
  // The server's refusal (bad ticket, rate limit, proxy without WebSocket
  // support, a 502 mid-deploy). Handling this event means `ws` won't abort or
  // close on its own: end the request here and try again later.
  ws.on("unexpected-response", (req, res) => {
    const status = res.statusCode ?? 0;
    log.warn(`[ws] server refused the connection: HTTP ${status || "?"}`);
    req.destroy();
    res.resume();
    scheduleReconnect(gen, status === 401 || status === 403 ? "auth" : "server");
  });
  ws.onclose = (evt) => {
    if (gen !== generation || !active) return;
    log.warn(`[ws] connection closed (${evt.code}${evt.reason ? `: ${evt.reason}` : ""}), retrying`);
    scheduleReconnect(gen, evt.code === 1001 || evt.code === 1006 ? "network" : "server");
  };
  ws.onerror = (evt) => {
    if (gen !== generation) return;
    log.warn("[ws] connection error", evt.message);
    scheduleReconnect(gen, "network");
  };
}

export function startWsClient(): void {
  if (active) return;
  active = true;
  attempt = 0;
  emitStatus("connecting");
  void connect();
}

export function stopWsClient(): void {
  if (!active) return;
  active = false;
  generation += 1;
  clearTimers();
  dropSocket();
  emitStatus("offline");
}

/** After sleep, screen unlock or the network coming back: reconnect now, with the backoff reset. */
export function resumeWsClient(why: string): void {
  if (!active) return;
  log.info(`[ws] ${why}: reconnecting now`);
  attempt = 0;
  emitStatus("reconnecting", "network");
  void connect();
}
