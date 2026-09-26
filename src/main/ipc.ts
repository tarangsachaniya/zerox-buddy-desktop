import { app, ipcMain, shell } from "electron";
import electronLog from "electron-log/main";
import { dirname } from "node:path";

import type { IpcResult } from "../shared/types";
import { ApiError } from "./auth/api-client";
import { getState } from "./state";

/**
 * Every renderer → main call goes through handle(): errors come back as
 * { ok: false, error } values, never as thrown IPC errors, so the UI can show
 * the message as-is. Tokens never cross this boundary.
 */
export function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn(...(args as A)) };
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      return { ok: false, error: err instanceof Error ? err.message : "Something went wrong", status };
    }
  });
}

export function registerAppHandlers(): void {
  handle("app:getState", () => getState());
  handle("app:openLogs", async () => {
    await shell.openPath(dirname(electronLog.transports.file.getFile().path));
  });
  handle("app:openWebDashboard", async (path: unknown) => {
    const suffix = typeof path === "string" && path.startsWith("/") ? path : "";
    await shell.openExternal(`https://zerox.priinteve.com/dashboard${suffix}`);
  });
  handle("app:quit", () => app.quit());
}
