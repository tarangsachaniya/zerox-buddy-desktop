import { app, shell } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type { PickedFile } from "../../shared/types";
import { WEB_APP_URL } from "../config";
import { log } from "../log";
import { MAX_LOCAL_BYTES, register } from "../local-print/files";
import { DriveImportError, fetchDriveFile } from "./drive-import";

/**
 * "From Google Drive" at the counter.
 *
 * Google refuses to sign in inside an app's own window, so the picker runs on
 * zerox.priinteve.com/drive-pick in the real browser. This computer listens
 * on 127.0.0.1 (random port, one request, two minutes) with a one-time state;
 * the page posts the picked file ids and a short-lived drive.file token back
 * to it. The files are downloaded straight from Google into a temporary
 * folder and handed to Print from PC. The token is used for those downloads
 * only and never written anywhere.
 */

const WAIT_MS = 2 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

let inProgress = false;

export function importsDir(): string {
  return join(app.getPath("userData"), "drive-imports");
}

/** Deletes imports older than a day that no job kept (crash, or a pick never printed). */
export async function sweepDriveImports(): Promise<void> {
  const dir = importsDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > TEMP_TTL_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:28rem;margin:20vh auto;text-align:center"><h1 style="font-size:1.4rem">${title}</h1><p style="color:#555">${body}</p></body>`,
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Picked = { accessToken: string; files: { id: string; name: string; mimeType: string }[] };

/** Opens the browser picker and waits for its answer; null if the person closed it or it timed out. */
function waitForPick(): Promise<Picked | null> {
  const state = randomBytes(24).toString("base64url");
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value: Picked | null, err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(value);
    };
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      readBody(req)
        .then((raw) => {
          const form = new URLSearchParams(raw);
          if (form.get("state") !== state) {
            page(res, 400, "This link has expired", "Go back to Zerox Buddy and choose “From Google Drive” again.");
            return;
          }
          const accessToken = form.get("accessToken") ?? "";
          let files: Picked["files"] = [];
          try {
            const parsed = JSON.parse(form.get("files") ?? "[]") as unknown;
            if (Array.isArray(parsed)) {
              files = parsed
                .filter((f): f is Picked["files"][number] => !!f && typeof f.id === "string" && typeof f.name === "string" && typeof f.mimeType === "string")
                .slice(0, 10);
            }
          } catch {
            // falls through to "no files"
          }
          page(res, 200, "Sent to Zerox Buddy", "You can close this tab and go back to the app.");
          finish(accessToken && files.length ? { accessToken, files } : null);
        })
        .catch(() => {
          res.writeHead(400).end();
        });
    });
    const timer = setTimeout(() => finish(null), WAIT_MS);
    server.on("error", (err) => finish(null, err));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const url = new URL("/drive-pick", WEB_APP_URL);
      url.searchParams.set("return", `http://127.0.0.1:${port}/cb`);
      url.searchParams.set("state", state);
      void shell.openExternal(url.toString());
    });
  });
}

/**
 * The whole flow: browser picker → download each file → checked like any
 * picked file. Each result is a file ready for Print from PC, or why not.
 */
export async function pickFromDrive(): Promise<(PickedFile | { name: string; error: string })[]> {
  if (inProgress) throw new Error("Google Drive is already open in your browser. Finish picking there, or wait two minutes.");
  inProgress = true;
  try {
    const picked = await waitForPick();
    if (!picked) return [];
    const dir = join(importsDir(), randomUUID());
    await mkdir(dir, { recursive: true });
    const out: (PickedFile | { name: string; error: string })[] = [];
    for (const f of picked.files) {
      try {
        const file = await fetchDriveFile(f.id, picked.accessToken, MAX_LOCAL_BYTES);
        const path = join(dir, `${out.length + 1}-${file.mimeType === "application/pdf" ? "doc.pdf" : file.mimeType === "image/png" ? "image.png" : "image.jpg"}`);
        await writeFile(path, file.bytes);
        out.push(await register(path, "google_drive", { temp: true, name: file.name }));
      } catch (err) {
        const code = err instanceof DriveImportError ? err.code : "error";
        log.warn(`[drive] import refused: ${code}`);
        out.push({ name: f.name, error: err instanceof Error ? err.message : "Couldn't download it from Google Drive" });
      }
    }
    log.info(`[drive] imported ${out.filter((r) => "pickId" in r).length} of ${picked.files.length} file(s)`);
    return out;
  } finally {
    inProgress = false;
  }
}
