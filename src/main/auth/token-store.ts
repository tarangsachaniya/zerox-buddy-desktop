import { app, safeStorage } from "electron";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * This computer's Zerox Buddy Desktop session. Held in main-process memory
 * and persisted encrypted (safeStorage) — the renderer never sees a token.
 * Copied from priinteve-owner-desktop's token-store.ts, reshaped for Zerox.
 */
export type DesktopSession = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessTokenExpiresAt: number;
  deviceId: string;
  shop: { id: string; shopName: string; shopCode: string };
  email: string;
};

let current: DesktopSession | null = null;

function sessionPath(): string {
  return join(app.getPath("userData"), "session.enc");
}

export function getSession(): DesktopSession | null {
  return current;
}

export async function setSession(next: DesktopSession): Promise<void> {
  current = next;
  if (!safeStorage.isEncryptionAvailable()) return; // fail closed: sign in again next launch
  await writeFile(sessionPath(), safeStorage.encryptString(JSON.stringify(next)));
}

export async function clearSession(): Promise<void> {
  current = null;
  await unlink(sessionPath()).catch(() => {});
}

/** Called once at startup. */
export async function loadPersistedSession(): Promise<DesktopSession | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    current = JSON.parse(safeStorage.decryptString(await readFile(sessionPath()))) as DesktopSession;
    return current;
  } catch {
    return null; // missing, corrupt, or another Windows profile's key
  }
}
