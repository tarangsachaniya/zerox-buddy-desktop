import type { OwnerSubscription, Plan } from "../shared/types";
import { deviceRequest } from "./auth/api-client";
import { API_BASE_URL } from "./config";

/**
 * What the in-app Subscription screen shows: this shop's plan/usage/trial
 * (device-scoped, bearer auth) plus the full plan catalog for comparison
 * (GET /api/zerox/plans is public — the same marketing pricing endpoint the
 * web app's home page reads — so it's fetched directly, no device auth
 * needed). One IPC round trip; the renderer never touches the network itself.
 */
export async function getSubscription(): Promise<{ subscription: OwnerSubscription; plans: Plan[] }> {
  const [subscription, plansRes] = await Promise.all([
    deviceRequest<OwnerSubscription>("/subscription"),
    fetch(`${API_BASE_URL}/api/zerox/plans`).then((r) => r.json() as Promise<{ plans: Plan[] }>),
  ]);
  return { subscription, plans: plansRes.plans };
}
