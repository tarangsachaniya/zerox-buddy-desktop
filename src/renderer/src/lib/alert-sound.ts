import { useEffect, useRef, useState } from "react";

import type { AppState } from "../../../shared/types";
import { limitsOf } from "../../../shared/print-limits";

/**
 * The chime for big requests: while one waits for the counter to check it,
 * the window plays three rising tones, again every 30 s, until it's
 * previewed, printed, stopped or deleted (it then leaves `state.review`).
 * Made with Web Audio, so there's no sound file to ship. Muting is per
 * request and lasts until it leaves the queue.
 */

const REPEAT_MS = 30_000;

let ctx: AudioContext | null = null;

export function playChime(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const start = ctx.currentTime + 0.02;
    [660, 880, 1175].forEach((freq, i) => {
      const t = start + i * 0.18;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    });
  } catch {
    // No audio device: the tray notification still tells the counter.
  }
}

const muted = new Set<string>();
const listeners = new Set<() => void>();

export function muteReview(jobId: string): void {
  muted.add(jobId);
  listeners.forEach((l) => l());
}

export function useMuted(jobId: string): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return muted.has(jobId);
}

/** Mounted once for the whole window. */
export function useBigJobAlert(state: AppState | null): void {
  const sound = limitsOf(state?.shop).bigJobSound;
  const waiting = Object.keys(state?.review ?? {});
  const key = waiting.sort().join(",");
  const heard = useRef(new Set<string>());

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    for (const id of [...muted]) if (!ids.includes(id)) muted.delete(id);
    for (const id of [...heard.current])
      if (!ids.includes(id)) heard.current.delete(id);
    if (!sound) return;
    const loud = () => ids.filter((id) => !muted.has(id));
    // A new request chimes at once; the reminder repeats while any is unchecked.
    if (ids.some((id) => !heard.current.has(id) && !muted.has(id))) playChime();
    ids.forEach((id) => heard.current.add(id));
    if (loud().length === 0) return;
    const timer = setInterval(() => {
      if (loud().length > 0) playChime();
    }, REPEAT_MS);
    const l = () => {
      if (loud().length === 0) clearInterval(timer);
    };
    listeners.add(l);
    return () => {
      clearInterval(timer);
      listeners.delete(l);
    };
  }, [key, sound]);
}
