// Builds the Microsoft Store packages (MSIX/.appx), x64 and ia32, into dist/.
//
// The package identity must match Partner Center → the app → Product identity.
// Put the three values in .env.store (not committed):
//
//   APPX_IDENTITY_NAME=12345Priinteve.ZeroxBuddy
//   APPX_PUBLISHER=CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
//   APPX_PUBLISHER_DISPLAY_NAME=Priinteve
//
// Without them (or with --test) it builds with test placeholders, for
// installing locally (signed with a self-signed test certificate) and running
// the Windows App Certification Kit. Never upload a test build.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const test = process.argv.includes("--test");

const env = { ...process.env };
const storeEnv = join(root, ".env.store");
if (!test && existsSync(storeEnv)) {
  for (const line of readFileSync(storeEnv, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const KEYS = ["APPX_IDENTITY_NAME", "APPX_PUBLISHER", "APPX_PUBLISHER_DISPLAY_NAME"];
const missing = KEYS.filter((k) => !env[k]);
if (test || missing.length) {
  if (!test) console.warn(`[build-store] ${missing.join(", ")} not set: building a TEST package (don't upload it).`);
  env.APPX_IDENTITY_NAME = "Priinteve.ZeroxBuddy.Test";
  env.APPX_PUBLISHER = "CN=ZeroxBuddyTest";
  env.APPX_PUBLISHER_DISPLAY_NAME = "Priinteve (test)";
}

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Quoted for the shell: the publisher looks like "CN=…" and may contain spaces or commas.
const q = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const identity = [
  `-c.appx.identityName=${q(env.APPX_IDENTITY_NAME)}`,
  `-c.appx.publisher=${q(env.APPX_PUBLISHER)}`,
  `-c.appx.publisherDisplayName=${q(env.APPX_PUBLISHER_DISPLAY_NAME)}`,
];
const builder = ["electron-builder", "--win", "appx", "--config", "electron-builder.yml", "--publish", "never", ...identity];

run("npx", ["electron-vite", "build"]);
run("npx", [...builder, "--x64"]);
// Electron 43 is the last line with 32-bit Windows (same as build:win:ia32).
run("npx", [...builder, "--ia32", "-c.electronVersion=43.7.5"]);
