import { describe, expect, test } from "vitest";

import { toLocationReading } from "./location";

describe("toLocationReading", () => {
  test("a fix becomes a reading with rounded accuracy", () => {
    expect(toLocationReading({ status: "Ready", permission: "Granted", lat: 21.17, lng: 72.83, accuracy: 84.6 })).toEqual({
      ok: true,
      lat: 21.17,
      lng: 72.83,
      accuracy: 85,
    });
  });
  test("missing accuracy is null", () => {
    expect(toLocationReading({ lat: 21.17, lng: 72.83 })).toEqual({ ok: true, lat: 21.17, lng: 72.83, accuracy: null });
  });
  test("denied, off and nothing yet", () => {
    expect(toLocationReading({ status: "NoData", permission: "Denied" })).toEqual({ ok: false, reason: "denied" });
    expect(toLocationReading({ status: "Disabled", permission: "Granted" })).toEqual({ ok: false, reason: "off" });
    expect(toLocationReading({ status: "Initializing", permission: "Granted" })).toEqual({ ok: false, reason: "unavailable" });
  });
  test("0,0 and out-of-range numbers are not a position", () => {
    expect(toLocationReading({ status: "Ready", lat: 0, lng: 0 }).ok).toBe(false);
    expect(toLocationReading({ status: "Ready", lat: 120, lng: 72 }).ok).toBe(false);
  });
});
