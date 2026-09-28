import type { PriceRule } from "../shared/types";
import { deviceRequest } from "./auth/api-client";

/**
 * The shop's rate card, editable in-app — same GET/PUT /pricing shape the web
 * dashboard's Pricing page uses, reusing the same server-side validation and
 * storage (services/zerox/shop.ts's listPriceRules/updatePriceRules). One IPC
 * round trip each way; the renderer never touches the network itself.
 */

export async function getPricing(): Promise<{ rules: PriceRule[] }> {
  return deviceRequest<{ rules: PriceRule[] }>("/pricing");
}

export async function updatePricing(
  rules: { kind: PriceRule["kind"]; paperSize: string; printType: PriceRule["printType"]; price: number }[],
): Promise<{ rules: PriceRule[] }> {
  return deviceRequest<{ rules: PriceRule[] }>("/pricing", { method: "PUT", body: { rules } });
}
