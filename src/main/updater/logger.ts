import { app } from "electron";
import path from "node:path";
import electronLog from "electron-log/main";

// Its own instance: reconfiguring the default logger's file transport would
// move every main.log line into updater.log too.
const log = electronLog.create({ logId: "updater" });
let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  log.transports.file.resolvePathFn = () => path.join(app.getPath("userData"), "logs", "updater.log");
  log.transports.file.level = "info";
}

type LogFields = Record<string, string | number | boolean | null | undefined>;

function entry(event: string, fields?: LogFields): Record<string, unknown> {
  return { event, ...fields, timestamp: new Date().toISOString() };
}

/** One structured line per call. Never pass tokens or raw Error objects in `fields`. */
export const updaterLog = {
  info(event: string, fields?: LogFields): void {
    ensureConfigured();
    log.info(entry(event, fields));
  },
  warn(event: string, fields?: LogFields): void {
    ensureConfigured();
    log.warn(entry(event, fields));
  },
  error(event: string, fields?: LogFields): void {
    ensureConfigured();
    log.error(entry(event, fields));
  },
};
