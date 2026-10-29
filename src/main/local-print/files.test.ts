import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "." } }));

import { FileRejected, getPick, readChecked, register, releasePick } from "./files";

const dir = mkdtempSync(join(tmpdir(), "zx-local-"));

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return doc.save();
}

describe("Print from PC: checking a picked file", () => {
  test("a PDF is measured by its pages; the path stays out of what the window gets", async () => {
    const path = join(dir, "notes.pdf");
    writeFileSync(path, await pdf(3));
    const r = await register(path, "local_pc");
    expect(r).toMatchObject({ name: "notes.pdf", mimeType: "application/pdf", pages: 3, source: "local_pc" });
    expect(JSON.stringify(r)).not.toContain(dir);
  });

  test("the type comes from the bytes: a PNG named .jpg is a PNG, a renamed program is refused", async () => {
    const png = join(dir, "photo.jpg");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    expect(await register(png, "local_pc")).toMatchObject({ mimeType: "image/png", pages: 1 });
    const exe = join(dir, "invoice.pdf");
    writeFileSync(exe, Buffer.from("MZ\x90\x00 not a pdf"));
    expect(await register(exe, "local_pc")).toMatchObject({ error: expect.stringContaining("Only PDF, JPG and PNG") });
  });

  test("empty, missing and damaged files say why", async () => {
    const empty = join(dir, "empty.pdf");
    writeFileSync(empty, "");
    expect(await register(empty, "local_pc")).toMatchObject({ error: "This file is empty." });
    expect(await register(join(dir, "gone.pdf"), "local_pc")).toMatchObject({ error: expect.stringContaining("isn't there any more") });
    const broken = join(dir, "broken.pdf");
    writeFileSync(broken, "%PDF-1.7\nnot really");
    expect(await register(broken, "local_pc")).toMatchObject({ error: expect.stringContaining("damaged") });
  });

  test("a file changed after it was picked isn't printed", async () => {
    const path = join(dir, "letter.pdf");
    writeFileSync(path, await pdf(1));
    const r = await register(path, "local_pc");
    if (!("pickId" in r)) throw new Error(r.error);
    const pick = getPick(r.pickId);
    await expect(readChecked(pick)).resolves.toBeInstanceOf(Uint8Array);
    writeFileSync(path, await pdf(2));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await expect(readChecked(pick)).rejects.toBeInstanceOf(FileRejected);
    releasePick(r.pickId);
    expect(() => getPick(r.pickId)).toThrow(/Choose it again/);
  });
});
