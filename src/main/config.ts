/**
 * priinteve-api's public origin, called directly with a bearer token (never
 * through a browser proxy). Same env-var names as priinteve-owner-desktop.
 */
export const API_BASE_URL = import.meta.env.MAIN_VITE_API_BASE_URL || "http://127.0.0.1:4000";

/** Its own constant, never a scheme-swap of API_BASE_URL (see owner-desktop config.ts). */
export const WS_BASE_URL = import.meta.env.MAIN_VITE_WS_URL || "ws://127.0.0.1:4000";

/**
 * Installed from the Microsoft Store (MSIX). The Store updates the app and
 * owns start-with-Windows (a StartupTask in the package manifest), so this
 * build never runs its own updater or touches the Run registry key.
 */
export const IS_STORE_BUILD = process.windowsStore === true;

export const INCLUDE_VIRTUAL_PRINTERS = import.meta.env.MAIN_VITE_INCLUDE_VIRTUAL_PRINTERS === "1";

/** Must equal electron-builder.yml's appId (taskbar icon and notifications). */
export const APP_ID = "com.priinteve.zerox-desktop";

/**
 * Release slug on /api/app-updates, one per installer architecture so a
 * 32-bit install never downloads the 64-bit build. (VentaDot Owner is "win32".)
 */
export const UPDATE_PLATFORM = process.arch === "ia32" ? "zerox-win32-ia32" : "zerox-win32";
