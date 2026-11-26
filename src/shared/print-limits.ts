import type { ShopInfo } from "./types";

export type PrintLimits = {
  bigJobPreviewPages: number;
  bigJobSound: boolean;
  batchPauseAfter: number;
  batchPauseMinutes: number;
};

/** What a shop gets when the server doesn't send them (an older API). */
export const DEFAULT_LIMITS: PrintLimits = { bigJobPreviewPages: 50, bigJobSound: true, batchPauseAfter: 10, batchPauseMinutes: 5 };

export function limitsOf(shop: Partial<ShopInfo> | null | undefined): PrintLimits {
  return {
    bigJobPreviewPages: shop?.bigJobPreviewPages ?? DEFAULT_LIMITS.bigJobPreviewPages,
    bigJobSound: shop?.bigJobSound ?? DEFAULT_LIMITS.bigJobSound,
    batchPauseAfter: shop?.batchPauseAfter ?? DEFAULT_LIMITS.batchPauseAfter,
    batchPauseMinutes: shop?.batchPauseMinutes ?? DEFAULT_LIMITS.batchPauseMinutes,
  };
}
