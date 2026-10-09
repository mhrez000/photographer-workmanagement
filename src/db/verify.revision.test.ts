/** db:verify — the open revision's assignee must be the job's editor. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { withTx } from "@/server/services/_shared";
import { requestRevision } from "@/server/services/revisions";
import { verifyDerived } from "./verify";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

describe("open_revision_assignee_is_editor", () => {
  it("is clean after a normal request and flags a manually diverged row", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const res = withTx((tx) => requestRevision(tx, contextFor(db, ids.users.manager), { jobId: job.id, expectedVersion: job.version, reason: "Colour", description: "Too cold" }), { db });
    expect(verifyDerived(db.$client).structural).toEqual([]);

    // the pre-fix PATCH /api/revisions/:id wrote only the revision row
    db.$client.prepare("UPDATE job_revisions SET assignee_user_id = ? WHERE id = ?").run(ids.users.editor2, res.revision.id);
    const report = verifyDerived(db.$client);
    expect(report.ok).toBe(false);
    expect(report.structural).toEqual([expect.objectContaining({ check: "open_revision_assignee_is_editor", jobId: job.id })]);

    // an unassigned revision (assignee null) is not a divergence
    db.$client.prepare("UPDATE job_revisions SET assignee_user_id = NULL WHERE id = ?").run(res.revision.id);
    expect(verifyDerived(db.$client).structural).toEqual([]);
  });
});
