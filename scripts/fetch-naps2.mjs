// Fetches the pinned NAPS2 build Zerox Buddy Desktop scans with, into
// resources/naps2/x64/ (gitignored; shipped via electron-builder
// extraResources). Runs on postinstall. Verifies the download's SHA-256 so a
// tampered or changed file never ends up in an installer.
//
// NAPS2 has no 32-bit Windows build: resources/naps2/ia32/ is left empty, so
// the ia32 installer ships without it and the app hides Scan there.
//
// NAPS2 is GPLv2 and is shipped unmodified as a separate program (its
// console, NAPS2.Console.exe, is run as a child process); its licence is
// App/license.txt inside the folder, and resources/NAPS2-LICENSE.txt points to it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "8.5.1";
const URL = `https://github.com/cyanfish/naps2/releases/download/v${VERSION}/naps2-${VERSION}-win-x64.zip`;
const SHA256 = "62e1b0348863919a6d1b4916d2983793159af82685fc1ebed6df715d36a52d2a";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "resources", "naps2");

if (process.platform !== "win32") {
  console.log("[fetch-naps2] not Windows; skipping (Zerox Buddy Desktop scans on Windows only)");
  process.exit(0);
}

mkdirSync(join(base, "ia32"), { recursive: true });
const target = join(base, "x64");
if (existsSync(join(target, "App", "NAPS2.Console.exe"))) {
  console.log("[fetch-naps2] x64 already present");
  process.exit(0);
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`[fetch-naps2] download failed: HTTP ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const hash = createHash("sha256").update(zip).digest("hex");
if (hash !== SHA256) throw new Error(`[fetch-naps2] checksum mismatch: got ${hash}`);

const work = mkdtempSync(join(tmpdir(), "naps2-"));
try {
  const zipPath = join(work, "naps2.zip");
  const out = join(work, "x");
  writeFileSync(zipPath, zip);
  execFileSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`],
    { stdio: "inherit" },
  );
  if (!existsSync(join(out, "App", "NAPS2.Console.exe"))) throw new Error("[fetch-naps2] NAPS2.Console.exe not found in archive");
  rmSync(target, { recursive: true, force: true });
  // Only the program itself: the portable launcher and its Data folder aren't used.
  cpSync(join(out, "App"), join(target, "App"), { recursive: true }); // copy, not rename: temp may be on another drive
  console.log(`[fetch-naps2] NAPS2 ${VERSION} x64 ready`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
