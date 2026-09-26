import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";

import type { AppState } from "../shared/types";

/**
 * Zerox Buddy lives in the tray: closing the window keeps it printing.
 * The tooltip and menu say whether it's online and what it's doing.
 */

let tray: Tray | null = null;

export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(__dirname, "../../resources", name);
}

function statusLine(state: AppState): string {
  if (!state.signedIn) return "Not signed in";
  if (state.connection !== "online") return state.connection === "connecting" ? "Connecting…" : "Offline, retrying";
  const printing = Object.values(state.local).filter((l) => l.phase === "printing" || l.phase === "downloading").length;
  if (printing) return `Printing ${printing} ${printing === 1 ? "job" : "jobs"}`;
  const waiting = state.queue.waiting.length;
  return waiting ? `${waiting} waiting` : "Ready";
}

export function createTray(actions: { show: () => void; quit: () => void }): Tray {
  tray = new Tray(nativeImage.createFromPath(resourcePath("tray.png")));
  tray.setToolTip("Zerox Buddy");
  tray.on("click", actions.show);
  tray.on("double-click", actions.show);
  (tray as Tray & { actions?: typeof actions }).actions = actions;
  return tray;
}

export function updateTray(state: AppState): void {
  if (!tray) return;
  const line = statusLine(state);
  tray.setToolTip(`Zerox Buddy · ${line}`);
  const actions = (tray as Tray & { actions?: { show: () => void; quit: () => void } }).actions!;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: state.shop ? state.shop.shopName : "Zerox Buddy", enabled: false },
      { label: line, enabled: false },
      { type: "separator" },
      { label: "Open Zerox Buddy", click: actions.show },
      { type: "separator" },
      { label: "Quit (stops printing)", click: actions.quit },
    ]),
  );
}
