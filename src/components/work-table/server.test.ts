import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { listJobsApi } from "@/server/queries/jobs";

vi.mock("server-only", () => ({}));
const { safeListJobs } = await import("./server");

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  for (let i = 0; i < 4; i += 1) await insertJobFixture(db, ids, { statusKey: "in_progress", name: `Job ${i}` });
});
afterEach(() => fakeClock.reset());

describe("safeListJobs", () => {
  it("drops an unknown filter alias with a notice, so 'Load more' passes the strict API", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const { result, input, notice } = await safeListJobs(db, ctx, { filter: "foo", limit: "2" });
    expect(input).toEqual({ limit: "2" });
    expect(notice).toMatch(/invalid filter value/);
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
    // The "Load more" request = the returned input + cursor.
    await expect(listJobsApi(db, ctx, { ...input, cursor: result.nextCursor })).resolves.toBeDefined();
  });

  it("keeps a known alias (filter=mine) and drops keys the API does not know", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const { input, notice } = await safeListJobs(db, ctx, { filter: "mine", utm_source: "x" });
    expect(input).toEqual({ filter: "mine" });
    expect(notice).toBeNull();
    await expect(listJobsApi(db, ctx, input)).resolves.toBeDefined();
  });
});
