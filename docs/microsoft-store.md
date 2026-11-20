# Publishing Zerox Buddy on the Microsoft Store

The Store build is an MSIX package (`.appx`). Microsoft signs it when you
upload it, so shops get no SmartScreen warning, and the Store keeps it updated.
The `.exe` installers (`npm run build:win`) stay as the fallback download.

## What's different in the Store build

`process.windowsStore` is true, and `IS_STORE_BUILD` in `src/main/config.ts` follows it:

| | `.exe` (NSIS) | Store (MSIX) |
|---|---|---|
| Updates | own updater (`src/main/updater`) | Microsoft Store; own updater never runs |
| Start with Windows | Run registry key, switch in Settings | package StartupTask, changed in Windows Settings → Apps → Startup |
| Starts hidden at boot | `--hidden` argument | launched within 3 minutes of boot |
| Signing | unsigned | signed by Microsoft on upload |

## One-time setup in Partner Center (you)

1. Sign in at https://partner.microsoft.com/dashboard with a Microsoft account and
   register as a developer (individual: free; company: needs business verification).
2. Apps and games → New product → **MSIX or PWA app** → reserve the name **Zerox Buddy**.
3. Product management → **Product identity**. Copy into `priinteve-zerox-desktop/.env.store`
   (not committed):
   ```
   APPX_IDENTITY_NAME=<Package/Identity/Name>
   APPX_PUBLISHER=<Package/Identity/Publisher, starts with CN=>
   APPX_PUBLISHER_DISPLAY_NAME=<Package/Properties/PublisherDisplayName>
   ```

## Build

```bash
npm run build:store          # real packages, uses .env.store
npm run build:store -- --test   # test identity, for local install + WACK only
```

Output in `dist/`: `Zerox-Buddy-<version>-x64.appx` and `Zerox-Buddy-<version>-ia32.appx`.
Upload both to the same submission. Every submission needs a higher `version` in
`package.json` (it becomes `x.y.z.0`).

## Test before uploading

1. Build with `--test`, sign the `.appx` with a self-signed test certificate whose
   subject is `CN=ZeroxBuddyTest`, trust it (Local Machine → Trusted People), then
   `Add-AppxPackage .\dist\Zerox-Buddy-<version>-x64.appx`.
   If the old `.exe` version is installed, uninstall it first.
2. Check: sign in, printers listed, auto-print, Preview, passport sheet, scan,
   Print from PC, tray icon, close to tray, restart Windows (opens in the tray),
   Settings shows "Updates come from the Microsoft Store", uninstall.
3. Run the **Windows App Certification Kit** (in the Windows SDK) on the `.appx`
   and fix every failure.

## Store listing (Partner Center → submission)

- **Pricing and availability**: free; markets India (or all).
- **Properties**: category Business; privacy policy URL
  `https://zerox.priinteve.com/legal/privacy`; support contact; website
  `https://zerox.priinteve.com`.
- **Age ratings**: fill the questionnaire (no user-generated content shared
  publicly, no purchases inside the app).
- **Store listing (English)**: description, short description, at least one
  screenshot (1366×768 or larger: Queue, Printers, Settings), app icon from
  `build/icon.png`.
- **Submission options → Notes for certification** (testers must be able to sign in):
  > Zerox Buddy is the counter app for print shops. Sign in with the test shop
  > below. It needs an installed printer; "Microsoft Print to PDF" works for
  > testing. To send a test order, open <QR link of the test shop> on a phone.
  > Test shop: <email> / <password>
  Create a dedicated test shop for this, on a plan with printing on, with no
  shop location set (so the testers' phones aren't refused).
- **Restricted capability**: `runFullTrust` is declared (every Electron app needs
  it). Justification: "Desktop app that prints to the shop's Windows printers
  using bundled SumatraPDF and reads printer capabilities through Windows PowerShell."

Certification usually takes 1–3 working days. After it's live, set
`NEXT_PUBLIC_MS_STORE_URL` on the zerox site (Vercel) to the Store link so
`/download` shows the "Get it from Microsoft Store" button.

## Moving a shop from the `.exe` to the Store app

The Store app reads the same `%APPDATA%\priinteve-zerox-desktop\machine-id`, so
the computer keeps its device and printer settings. Uninstall the `.exe` version
first so the two don't run side by side.
