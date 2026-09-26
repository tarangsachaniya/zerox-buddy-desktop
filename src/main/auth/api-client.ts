import { app } from "electron";
import { hostname } from "node:os";

import type { Bootstrap } from "../../shared/types";
import { API_BASE_URL } from "../config";
import { machineId } from "../machine-id";
import { clearSession, getSession, setSession, type DesktopSession } from "./token-store";

/**
 * Bearer-token client for /api/zerox/device. Same two-layer defence as
 * priinteve-owner-desktop's api-client.ts: refresh ahead of expiry, and retry
 * once on a 401 (the tracked expiry is only as good as this machine's clock).
 * Concurrent refreshes share one request.
 */
const REFRESH_SKEW_MS = 60_000;
const DEVICE = "/api/zerox/device";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; code?: string };
    return new ApiError(res.status, body.error || res.statusText || "Request failed", body.code);
  } catch {
    return new ApiError(res.status, text || res.statusText || "Request failed");
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-App-Version": app.getVersion(), ...extra };
}

type LoginResponse = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  deviceId: string;
} & Bootstrap;

export async function login(email: string, password: string): Promise<{ session: DesktopSession; bootstrap: Bootstrap }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${DEVICE}/login`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        email,
        password,
        deviceName: hostname().slice(0, 80) || "Shop computer",
        machineId: machineId(),
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
    });
  } catch {
    throw new ApiError(0, "Can't reach Zerox Buddy. Check the internet connection.");
  }
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as LoginResponse;
  const session: DesktopSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    accessTokenExpiresAt: Date.now() + body.accessTokenExpiresIn * 1000,
    deviceId: body.deviceId,
    shop: { id: body.shop.id, shopName: body.shop.shopName, shopCode: body.shop.shopCode },
    email,
  };
  await setSession(session);
  return { session, bootstrap: { shop: body.shop, entitlements: body.entitlements, printers: body.printers } };
}

async function doRefresh(): Promise<void> {
  const session = getSession();
  if (!session) throw new ApiError(401, "Not signed in");
  const res = await fetch(`${API_BASE_URL}${DEVICE}/token/refresh`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    // Only a real rejection ends the session; a 5xx or dropped connection doesn't.
    if (res.status === 401 || res.status === 403) {
      await clearSession();
      throw new ApiError(401, "Signed out. Please sign in again.");
    }
    throw await readError(res);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string; accessTokenExpiresIn: number };
  await setSession({
    ...session,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    accessTokenExpiresAt: Date.now() + body.accessTokenExpiresIn * 1000,
  });
}

let refreshInFlight: Promise<void> | null = null;
function refreshAccessToken(): Promise<void> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function logout(): Promise<void> {
  const session = getSession();
  if (session) {
    await fetch(`${API_BASE_URL}${DEVICE}/logout`, {
      method: "POST",
      headers: headers({ Authorization: `Bearer ${session.accessToken}` }),
    }).catch(() => {});
  }
  await clearSession();
}

/** Authenticated call under /api/zerox/device. Throws ApiError(401) once the session is truly over. */
export async function deviceRequest<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!getSession()) throw new ApiError(401, "Not signed in");
  if (Date.now() >= getSession()!.accessTokenExpiresAt - REFRESH_SKEW_MS) await refreshAccessToken();

  const send = async (): Promise<Response> => {
    const session = getSession();
    if (!session) throw new ApiError(401, "Not signed in");
    try {
      return await fetch(`${API_BASE_URL}${DEVICE}${path}`, {
        method: init.method ?? "GET",
        headers: headers({
          Authorization: `Bearer ${session.accessToken}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        }),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new ApiError(0, "Can't reach Zerox Buddy. Check the internet connection.");
    }
  };

  let res = await send();
  if (res.status === 401) {
    await refreshAccessToken();
    res = await send();
  }
  if (res.status === 401) {
    await clearSession();
    throw new ApiError(401, "Signed out. Please sign in again.");
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export async function mintWsTicket(): Promise<string> {
  const { ticket } = await deviceRequest<{ ticket: string }>("/ws/ticket", { method: "POST" });
  return ticket;
}
