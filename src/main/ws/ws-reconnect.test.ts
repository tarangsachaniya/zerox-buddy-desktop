import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

/**
 * Against a real local server: the bug this guards against left the app
 * "Offline" until restarted whenever the server refused one handshake.
 */

const server = vi.hoisted(() => ({ port: 0 }));
vi.mock("../config", () => ({
  get WS_BASE_URL() {
    return `ws://127.0.0.1:${server.port}`;
  },
}));
vi.mock("../auth/api-client", () => ({ ApiError: class extends Error {}, mintWsTicket: async () => "ticket" }));
vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));

import { startWsClient, stopWsClient, wsEvents } from "./ws-client";

let http: Server | null = null;

function listen(onUpgrade: (n: number) => "refuse" | "accept"): Promise<{ wss: WebSocketServer; upgrades: () => number }> {
  let n = 0;
  const wss = new WebSocketServer({ noServer: true });
  http = createServer();
  http.on("upgrade", (req, socket, head) => {
    n += 1;
    if (onUpgrade(n) === "refuse") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return new Promise((resolve) =>
    http!.listen(0, "127.0.0.1", () => {
      server.port = (http!.address() as AddressInfo).port;
      resolve({ wss, upgrades: () => n });
    }),
  );
}

function waitFor(connection: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`never ${connection}`)), ms);
    const on = (s: { connection: string }) => {
      if (s.connection !== connection) return;
      clearTimeout(t);
      wsEvents.off("status", on);
      resolve();
    };
    wsEvents.on("status", on);
  });
}

afterEach(async () => {
  stopWsClient();
  vi.restoreAllMocks();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
});

describe("ws client against a real server", () => {
  test("a refused handshake (401) is retried until it connects", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // shortest backoff
    const { upgrades } = await listen((n) => (n === 1 ? "refuse" : "accept"));
    const online = waitFor("online");
    startWsClient();
    await online;
    expect(upgrades()).toBe(2);
  });

  test("stop, then start again, leaves exactly one socket", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { wss } = await listen(() => "accept");
    let online = waitFor("online");
    startWsClient();
    await online;
    stopWsClient();
    online = waitFor("online");
    startWsClient();
    await online;
    await new Promise((r) => setTimeout(r, 300));
    const open = [...wss.clients].filter((c) => c.readyState === c.OPEN);
    expect(open).toHaveLength(1);
  });
});
