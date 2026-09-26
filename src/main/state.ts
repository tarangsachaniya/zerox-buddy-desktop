import { app } from "electron";
import { EventEmitter } from "node:events";

import type { AppState } from "../shared/types";

/**
 * The single app state the renderer and the tray draw from. Main mutates it
 * through update(); every change is broadcast as "change".
 */
export const stateEvents = new EventEmitter();

let state: AppState = {
  signedIn: false,
  version: app.getVersion(),
  connection: "offline",
  shop: null,
  entitlements: null,
  printers: [],
  queue: { waiting: [], active: [], recent: [] },
  local: {},
  blocked: {},
  lastSyncAt: null,
  error: null,
  startWithWindows: false,
};

export function getState(): AppState {
  return state;
}

export function update(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  stateEvents.emit("change", state);
}

export function setLocal(jobId: string, local: AppState["local"][string] | null): void {
  const next = { ...state.local };
  if (local) next[jobId] = local;
  else delete next[jobId];
  update({ local: next });
}

export function resetForSignOut(): void {
  update({
    signedIn: false,
    shop: null,
    entitlements: null,
    printers: [],
    queue: { waiting: [], active: [], recent: [] },
    local: {},
    blocked: {},
    lastSyncAt: null,
    error: null,
    connection: "offline",
  });
}
