// Fetches the pinned SumatraPDF build Zerox Buddy Desktop prints with, into
// resources/SumatraPDF.exe (gitignored; shipped via electron-builder
// extraResources). Runs on postinstall. Verifies the download's SHA-256 so a
// tampered or changed file never ends up in an installer.
//
// SumatraPDF is GPLv3 and is shipped unmodified as a separate program; its
// licence and source link are in resources/SumatraPDF-LICENSE.txt.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3.5.2";
// One per installer architecture: a 32-bit Windows can't run the 64-bit build.
// electron-builder.yml picks resources/sumatra/${arch}/SumatraPDF.exe per build.
const BUILDS = {
  x64: { url: `https://www.sumatrapdfreader.org/dl/rel/${VERSION}/SumatraPDF-${VERSION}-64.zip`, sha256: "66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989" },
  ia32: { url: `https://www.sumatrapdfreader.org/dl/rel/${VERSION}/SumatraPDF-${VERSION}.zip`, sha256: "5f1f460ff72ddd48979dbcfc2d427d53a473d43e18425470c78e94b19fee70b6" },
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "win32") {
  console.log("[fetch-sumatra] not Windows; skipping (Zerox Buddy Desktop prints on Windows only)");
  process.exit(0);
}

for (const [arch, { url, sha256 }] of Object.entries(BUILDS)) {
  const target = join(root, "resources", "sumatra", arch, "SumatraPDF.exe");
  if (existsSync(target)) {
    console.log(`[fetch-sumatra] ${arch} already present`);
    continue;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`[fetch-sumatra] ${arch} download failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const hash = createHash("sha256").update(zip).digest("hex");
  if (hash !== sha256) throw new Error(`[fetch-sumatra] ${arch} checksum mismatch: got ${hash}`);

  const work = mkdtempSync(join(tmpdir(), "sumatra-"));
  try {
    const zipPath = join(work, "sumatra.zip");
    writeFileSync(zipPath, zip);
    execFileSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}' -Force`],
      { stdio: "inherit" },
    );
    const exe = readdirSync(work).find((f) => /^SumatraPDF.*\.exe$/i.test(f));
    if (!exe) throw new Error(`[fetch-sumatra] ${arch} exe not found in archive`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(work, exe), target); // copy, not rename: temp may be on another drive
    console.log(`[fetch-sumatra] SumatraPDF ${VERSION} ${arch} ready`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
