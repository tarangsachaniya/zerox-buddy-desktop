/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_API_BASE_URL?: string;
  readonly MAIN_VITE_WS_URL?: string;
  /** "1" to list PDF/XPS/virtual printers too (development and testing only). */
  readonly MAIN_VITE_INCLUDE_VIRTUAL_PRINTERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
