# Zerox Buddy Desktop

The Windows app a Zerox Buddy shop runs on its counter computer. It receives
print requests customers send through the shop's QR code and prints them on
the shop's own printers.

- Sign in with the shop owner's Zerox Buddy account (same as zerox.priinteve.com).
- Detects the Windows printers and their color / double-sided / A4 / A3 support
  (owner can correct what drivers misreport). Receipt and virtual printers are skipped.
- Prints automatically when the shop has **Print automatically** and **Choose the
  printer automatically** on (and preview off); otherwise the counter presses
  Print or Preview per request.
- Runs from the tray; closing the window keeps it printing. Starts with Windows.

## How printing works

| Step | Where |
|---|---|
| New request arrives | WebSocket (`zerox-device` ticket) plus a 20 s poll, `src/main/ws/ws-client.ts` |
| Pick a printer | `src/main/printing/router.ts` (compatible → available → least busy → priority) |
| Claim | `POST /api/zerox/device/jobs/:id/claim`, atomic on the server; the losing computer skips it |
| Download | 5-minute presigned link into `userData/jobs/<id>`, deleted afterwards |
| Print | Bundled SumatraPDF, silent, `src/main/printing/sumatra.ts` + `print-settings.ts` |
| Report | `POST /api/zerox/device/attempts/:id/status` |

No double printing: `src/main/printing/ledger.ts` records each hand-off to the
spooler. After a crash, a job that was being printed is reported as "check the
tray before printing again" and never re-sent automatically.

## Google Drive ("From Google Drive" in Print from PC)

Google doesn't allow sign-in inside an app's own window, so the desktop opens
`zerox.priinteve.com/drive-pick` in the normal browser:
1. The desktop listens on `127.0.0.1` on a random port, for one request,
   for 2 minutes, with a one-time code.
2. The page runs Google Picker and posts the picked files back.
3. The desktop downloads them from Google into `userData/drive-imports`.
   That copy is deleted once the job is settled, or after a day.

Nothing to configure here beyond `MAIN_VITE_WEB_URL` (already set in both
`.env` files). The Google side is set up once, for the web app: see
"Google Drive import" in `priinteve-zerox/README.md`. Until that's done, the
browser page says "This link has expired".

## Develop

```bash
npm install            # also fetches SumatraPDF 3.5.2 (SHA-256 pinned) into resources/
npm run dev            # uses .env.development: API at http://127.0.0.1:4999, virtual printers listed
npm test               # router + print settings unit tests
npm run typecheck
```

Run priinteve-api locally on port 4999 first (`PORT=4999 bun run src/index.ts`).

In a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` before launching Electron
yourself (`env -u ELECTRON_RUN_AS_NODE ...`); otherwise it starts as plain Node.

## Build the installer

```bash
npm run build:win      # uses .env.production (cards-api.priinteve.com)
```

Output: `dist/Zerox Buddy Setup <version>.exe`. Unsigned for now, so Windows
SmartScreen warns on first run ("More info" → "Run anyway").

## Uninstall

Settings → Apps → Zerox Buddy → Uninstall. It force-closes the tray app (and
SumatraPDF / NAPS2) first and removes start-with-Windows; see `build/installer.nsh`.

If it's no longer listed in Apps but still starts with Windows (a broken
install), send the shop the `uninstall/` folder and have them double-click
`Uninstall Zerox Buddy.cmd`. It keeps `%APPDATA%\priinteve-zerox-desktop`
(machine-id) unless they answer "y" to deleting saved data.

## Licences

SumatraPDF is included unmodified under the GNU GPLv3; see
`resources/SumatraPDF-LICENSE.txt` (shipped with the app).
