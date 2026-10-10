/** db:verify — the open revision's assignee must be the job's editor. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { withTx } from "@/server/services/_shared";
import { requestRevision } from "@/server/services/revisions";
import { verifyDerived } from "./verify";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

describe("open_revision_assignee_is_editor", () => {
  it("is clean after a normal request and flags a manually diverged row", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const ctx = await contextFor(db, ids.users.coAdmin);
    const res = await withTx(
      (tx) => requestRevision(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Colour", description: "Too cold" }),
      { db },
    );
    expect((await verifyDerived(db)).structural).toEqual([]);

    // the pre-fix PATCH /api/revisions/:id wrote only the revision row
    await db.$client.query("UPDATE job_revisions SET assignee_user_id = $1 WHERE id = $2", [ids.users.editor2, res.revision.id]);
    const report = await verifyDerived(db);
    expect(report.ok).toBe(false);
    expect(report.structural).toEqual([expect.objectContaining({ check: "open_revision_assignee_is_editor", jobId: job.id })]);

    // an unassigned revision (assignee null) is not a divergence
    await db.$client.query("UPDATE job_revisions SET assignee_user_id = NULL WHERE id = $1", [res.revision.id]);
    expect((await verifyDerived(db)).structural).toEqual([]);
  });
});
