/**
 * Downloads one file a customer picked with Google Picker, for printing.
 *
 * The browser asks Google for a short-lived access token with the
 * `drive.file` scope (only files the customer picks, so no Google security
 * review) and sends it here once, with the file id. It is used for these
 * requests and dropped: never stored, never logged, never echoed back.
 *
 *   regular files   PDF / JPEG / PNG, downloaded as they are (alt=media)
 *   Google files    Docs, Sheets, Slides and Drawings exported as PDF
 *                   (Google caps exports at 10 MB)
 *   anything else   refused with a message naming the type
 *
 * The body is read as a stream and abandoned the moment it passes the limit,
 * so a 2 GB video picked by mistake costs a few MB, not 2 GB.
 *
 * A copy of priinteve-api/src/services/zerox/drive-import.ts (keep the two in
 * step): the counter downloads straight from Drive, without the server.
 */

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const REQUEST_TIMEOUT_MS = 20_000;
/** No bytes for this long means the download is stuck. */
const IDLE_TIMEOUT_MS = 60_000;

const DIRECT = new Set(["application/pdf", "image/jpeg", "image/png"]);
const EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);

export type DriveFile = { name: string; mimeType: "application/pdf" | "image/jpeg" | "image/png"; bytes: Uint8Array };

export type DriveErrorCode = "auth" | "not_found" | "no_download" | "unsupported" | "too_large" | "timeout" | "network" | "google";

export class DriveImportError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    message: string,
    /** HTTP status for the API route that surfaces it. */
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function fail(code: DriveErrorCode, message: string, status = 400): never {
  throw new DriveImportError(code, message, status);
}

function sizeLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function call(fetchImpl: Fetch, url: string, token: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) fail("timeout", "Google Drive took too long to answer. Try again.", 504);
    fail("network", "Couldn't reach Google Drive. Try again.", 502);
  }
  if (res.ok) return res;
  // The body may describe the file; it's read only to classify, never returned.
  const text = await res.text().catch(() => "");
  if (res.status === 401) fail("auth", "Your Google sign-in expired. Pick the file from Google Drive again.", 401);
  if (res.status === 404) fail("not_found", "This file isn't available to the Google account you signed in with.", 404);
  if (res.status === 403) {
    if (/exportSizeLimitExceeded/i.test(text)) fail("too_large", "This Google file is too large to convert to PDF (Google allows up to 10 MB). Download it as PDF and upload that.", 413);
    if (/cannotDownload|downloadRestricted/i.test(text)) fail("no_download", "The owner of this file has turned off downloading, so it can't be printed.", 403);
    fail("not_found", "This file isn't available to the Google account you signed in with.", 403);
  }
  if (res.status === 429) fail("google", "Google Drive is busy. Wait a moment and try again.", 503);
  fail("google", `Google Drive had a problem (${res.status}). Try again.`, 502);
}

/** Reads a response body up to maxBytes; aborts past it or after IDLE_TIMEOUT_MS of silence. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) fail("too_large", `This file is too large. The limit is ${sizeLabel(maxBytes)}.`, 413);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idle = setTimeout(() => reject(new DriveImportError("timeout", "The download from Google Drive stalled. Try again.", 504)), IDLE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(idle));
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) fail("too_large", `This file is too large. The limit is ${sizeLabel(maxBytes)}.`, 413);
      chunks.push(next.value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof DriveImportError) throw err;
    fail("network", "The download from Google Drive was interrupted. Try again.", 502);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function withExtension(name: string, ext: string): string {
  const base = name.replace(/[\u0000-\u001f]/g, "").trim() || "document";
  return new RegExp(`\\.${ext}$`, "i").test(base) ? base : `${base.replace(/\.[a-z0-9]{2,5}$/i, "")}.${ext}`;
}

export async function fetchDriveFile(fileId: string, accessToken: string, maxBytes: number, fetchImpl: Fetch = fetch): Promise<DriveFile> {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) fail("not_found", "That isn't a Google Drive file.", 400);
  const id = encodeURIComponent(fileId);
  const meta = (await (
    await call(fetchImpl, `${DRIVE}/${id}?fields=id,name,mimeType,size,capabilities(canDownload)&supportsAllDrives=true`, accessToken)
  ).json()) as { name?: string; mimeType?: string; size?: string; capabilities?: { canDownload?: boolean } };

  const mimeType = (meta.mimeType ?? "").toLowerCase() === "image/jpg" ? "image/jpeg" : (meta.mimeType ?? "").toLowerCase();
  const name = meta.name ?? "document";
  if (meta.capabilities?.canDownload === false) fail("no_download", "The owner of this file has turned off downloading, so it can't be printed.", 403);

  if (EXPORTABLE.has(mimeType)) {
    const res = await call(fetchImpl, `${DRIVE}/${id}/export?mimeType=application%2Fpdf`, accessToken);
    return { name: withExtension(name, "pdf"), mimeType: "application/pdf", bytes: await readCapped(res, maxBytes) };
  }
  if (!DIRECT.has(mimeType)) {
    const what = mimeType.startsWith("application/vnd.google-apps.") ? "This kind of Google file" : `A ${mimeType || "file of this type"}`;
    fail("unsupported", `${what} can't be printed. Choose a PDF, JPG, PNG, or a Google Doc, Sheet or Slides file.`, 415);
  }
  if (meta.size && Number(meta.size) > maxBytes) fail("too_large", `This file is too large. The limit is ${sizeLabel(maxBytes)}.`, 413);
  if (meta.size === "0") fail("unsupported", "This file is empty.", 422);

  const res = await call(fetchImpl, `${DRIVE}/${id}?alt=media&supportsAllDrives=true`, accessToken);
  const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  return { name: withExtension(name, ext), mimeType: mimeType as DriveFile["mimeType"], bytes: await readCapped(res, maxBytes) };
}
