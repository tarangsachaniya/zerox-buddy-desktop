import { createContext, useContext, useEffect, useState } from "react";

import type { AppState, IpcResult } from "../../../shared/types";

/**
 * The main process owns all state and pushes it on every change; the
 * renderer only draws it and asks main to act.
 */
const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    void window.zerox.getState().then((r) => r.ok && setState(r.data));
    return window.zerox.onState(setState);
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState | null {
  return useContext(Ctx);
}

/** Unwraps an IpcResult: returns data or throws the message for a toast. */
export async function run<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const r = await call;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
