import { describe, expect, test, vi } from "vitest";

vi.mock("../auth/api-client", () => ({ ApiError: class extends Error {}, mintWsTicket: vi.fn() }));
vi.mock("../config", () => ({ WS_BASE_URL: "ws://127.0.0.1:1" }));
vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));

import { backoffDelay } from "./ws-client";

describe("reconnect backoff", () => {
  test("grows exponentially to a 30 s cap, with full jitter", () => {
    expect(backoffDelay(1, () => 1)).toBe(2000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0.5)).toBe(15_000);
  });
  test("never retries in a tight loop", () => {
    expect(backoffDelay(1, () => 0)).toBe(500);
  });
});
