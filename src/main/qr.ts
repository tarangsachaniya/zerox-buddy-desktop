import { app, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { QrPreview, ShopQr } from "../shared/types";
import { deviceRequest, deviceRequestBinary } from "./auth/api-client";
import { getState } from "./state";

/**
 * The desktop's QR screen: view and download only — regenerating a QR
 * revokes it shop-wide immediately, and the shop counter is the worst place
 * to offer that as a stray tap, so it stays a web-only action (see
 * priinteve-zerox's QR page). Every byte crosses main → renderer as either a
 * data: URL (preview) or a file already written to disk (download); the
 * renderer never sees a bearer-authenticated URL or touches the filesystem
 * itself (sandboxed by design).
 */

export async function getQr(): Promise<QrPreview> {
  const [{ qr }, png] = await Promise.all([
    deviceRequest<{ qr: ShopQr }>("/shop/qr"),
    deviceRequestBinary("/shop/qr.png"),
  ]);
  return { ...qr, pngDataUrl: `data:image/png;base64,${png.toString("base64")}` };
}

const EXT: Record<"png" | "svg" | "pdf", { path: string; filter: string }> = {
  png: { path: "/shop/qr.png", filter: "PNG image" },
  svg: { path: "/shop/qr.svg", filter: "SVG image" },
  pdf: { path: "/shop/qr.pdf", filter: "PDF poster" },
};

/** Saves the chosen format to disk via a native save dialog. Returns the saved path, or null if cancelled. */
export async function downloadQr(
  mainWindow: Electron.BrowserWindow,
  format: "png" | "svg" | "pdf",
): Promise<string | null> {
  const { path, filter } = EXT[format];
  const shopCode = getState().shop?.shopCode ?? "shop";
  const bytes = await deviceRequestBinary(path);

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save QR code",
    defaultPath: join(app.getPath("downloads"), `zerox-qr-${shopCode.toLowerCase()}.${format}`),
    filters: [{ name: filter, extensions: [format] }],
  });
  if (canceled || !filePath) return null;

  await writeFile(filePath, bytes);
  return filePath;
}
