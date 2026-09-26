import type { ZeroxApi } from "./index";

declare global {
  interface Window {
    zerox: ZeroxApi;
  }
}

export {};
