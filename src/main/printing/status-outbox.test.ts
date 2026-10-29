import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "zx-outbox-"));
vi.mock("electron", () => ({ app: { getPath: () => dir } }));
vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));
vi.mock("../auth/token-store", () => ({ getSession: () => ({ shop: { id: "shop-1" } }) }));
vi.mock("../auth/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  deviceRequest: vi.fn(),
}));

import { ApiError } from "../auth/api-client";
import { flushStatus, pendingAttemptIds, settle, type StatusReport } from "./status-outbox";

const stored = () => JSON.parse(readFileSync(join(dir, "status-outbox.json"), "utf8")) as StatusReport[];

describe("status outbox: an outcome is never lost", () => {
  beforeEach(async () => {
    // Empty it between tests.
    await flushStatus(async () => {});
  });

  test("delivered at once when the server answers", async () => {
    const sent: string[] = [];
    await settle({ attemptId: "a1", jobId: "j1", status: "COMPLETED", evidence: "spooler_gone" }, async (r) => void sent.push(`${r.attemptId}:${r.status}`));
    expect(sent).toEqual(["a1:COMPLETED"]);
    expect(stored()).toEqual([]);
  });

  test("offline: kept on disk, in order, and sent once the server is back", async () => {
    const offline = async () => {
      throw new ApiError(0, "offline");
    };
    await settle({ attemptId: "a1", jobId: "j1", status: "COMPLETED" }, offline);
    await settle({ attemptId: "a2", jobId: "j2", status: "UNKNOWN" }, offline);
    expect(stored().map((e) => e.attemptId)).toEqual(["a1", "a2"]);
    expect([...pendingAttemptIds()]).toEqual(["a1", "a2"]);

    const sent: string[] = [];
    await flushStatus(async (r) => void sent.push(r.attemptId));
    expect(sent).toEqual(["a1", "a2"]);
    expect(stored()).toEqual([]);
  });

  test("a 409 (already settled on the server) is dropped, the rest still go", async () => {
    const offline = async () => {
      throw new ApiError(0, "offline");
    };
    await settle({ attemptId: "a1", jobId: "j1", status: "FAILED" }, offline);
    await settle({ attemptId: "a2", jobId: "j2", status: "COMPLETED" }, offline);
    const sent: string[] = [];
    await flushStatus(async (r) => {
      if (r.attemptId === "a1") throw new ApiError(409, "already finished");
      sent.push(r.attemptId);
    });
    expect(sent).toEqual(["a2"]);
    expect(stored()).toEqual([]);
  });

  test("a 5xx keeps it for later", async () => {
    await settle({ attemptId: "a1", jobId: "j1", status: "COMPLETED" }, async () => {
      throw new ApiError(502, "bad gateway");
    });
    expect(stored().map((e) => e.attemptId)).toEqual(["a1"]);
  });
});
