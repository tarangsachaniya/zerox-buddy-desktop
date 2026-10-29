import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { EncryptedPDFError, PDFDocument } from "pdf-lib";

import type { LocalSource, PickedFile } from "../../shared/types";

/**
 * Files picked for "Print from PC" (and Google Drive imports, which land in
 * a temporary folder first). Every check happens here, in main: the window
 * only ever sees a pickId, a display name and what we measured. Paths never
 * leave this module except to be read for printing.
 *
 * The type comes from the bytes, not the extension: a renamed .exe isn't a
 * PDF just because it says so, and nothing here is ever opened or run.
 */

export const MAX_LOCAL_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 2000;

type Picked = PickedFile & { path: string; mtimeMs: number; temp: boolean };

const picks = new Map<string, Picked>();

export class FileRejected extends Error {}

export function sniff(head: Uint8Array): PickedFile["mimeType"] | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, Math.min(head.length, 1024)).includes("%PDF-")) return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "image/png";
  return null;
}

/** Pages in a PDF, refusing ones pdf-lib can't lay out (they'd print blank or garbled). */
export async function pdfPages(bytes: Uint8Array): Promise<number> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new FileRejected("This PDF is locked (password or print restriction). Open it, Print › Save as PDF (Microsoft Print to PDF), and print that copy.");
    }
    throw new FileRejected("This PDF looks damaged and can't be printed.");
  }
  let n: number;
  try {
    n = doc.getPageCount();
  } catch {
    // pdf-lib accepts some broken files and fails only when asked for the page tree.
    throw new FileRejected("This PDF looks damaged and can't be printed.");
  }
  if (n < 1) throw new FileRejected("This PDF has no pages.");
  if (n > MAX_PDF_PAGES) throw new FileRejected(`PDFs over ${MAX_PDF_PAGES} pages can't be printed here.`);
  return n;
}

function friendly(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "This file isn't there any more (moved or deleted).";
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") return "Windows won't let Zerox Buddy read this file. Close it in other apps, or copy it somewhere else first.";
  return err instanceof Error ? err.message : "Couldn't read this file.";
}

/** Checks one file and registers it; never throws (the reason comes back instead). */
export async function register(path: string, source: LocalSource, opts: { temp?: boolean; name?: string } = {}): Promise<PickedFile | { name: string; error: string }> {
  const name = opts.name ?? basename(path);
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new FileRejected("That isn't a file.");
    if (info.size === 0) throw new FileRejected("This file is empty.");
    if (info.size > MAX_LOCAL_BYTES) throw new FileRejected(`This file is over ${MAX_LOCAL_BYTES / 1024 / 1024} MB.`);
    const fh = await open(path, "r");
    const head = Buffer.alloc(1024);
    try {
      await fh.read(head, 0, 1024, 0);
    } finally {
      await fh.close();
    }
    const mimeType = sniff(head);
    if (!mimeType) throw new FileRejected("Only PDF, JPG and PNG files can be printed.");
    const pages = mimeType === "application/pdf" ? await pdfPages(await readFile(path)) : 1;
    const pick: Picked = { pickId: randomUUID(), name, mimeType, size: info.size, pages, source, path, mtimeMs: info.mtimeMs, temp: !!opts.temp };
    picks.set(pick.pickId, pick);
    const { path: _p, mtimeMs: _m, temp: _t, ...view } = pick;
    return view;
  } catch (err) {
    return { name, error: friendly(err) };
  }
}

export function getPick(pickId: string): Picked {
  const pick = typeof pickId === "string" ? picks.get(pickId) : undefined;
  if (!pick) throw new Error("This file was removed. Choose it again.");
  return pick;
}

export function releasePick(pickId: string): Picked | null {
  const pick = picks.get(pickId) ?? null;
  picks.delete(pickId);
  return pick;
}

/** Reads a picked file for printing, after checking it's still the file that was checked. */
export async function readChecked(ref: { path: string; size: number; mtimeMs: number }): Promise<Uint8Array> {
  let info;
  try {
    info = await stat(ref.path);
  } catch (err) {
    throw new FileRejected(friendly(err));
  }
  if (info.size !== ref.size || Math.abs(info.mtimeMs - ref.mtimeMs) > 1) {
    throw new FileRejected("This file changed since it was chosen. Choose it again.");
  }
  try {
    return await readFile(ref.path);
  } catch (err) {
    throw new FileRejected(friendly(err));
  }
}

/** For the log: never the full path (it can hold a customer's name). */
export function safeName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 18)}…${name.slice(-18)}` : name;
}
