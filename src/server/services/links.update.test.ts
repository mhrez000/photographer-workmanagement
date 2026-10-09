/** `updateLink` (PATCH /api/links/:id { kind?, label? }) — re-file / relabel a current link. */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, jobLinks } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { addLink, finishedWorkLinks, listLinks, updateLink } from "./links";

let db: TestDb;
let ids: SeedIds;
let jobId: string;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
  jobId = insertJobFixture(db, ids, { statusKey: "in_progress" }).job.id;
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.status;
    throw err;
  }
  return 200;
}

describe("updateLink", () => {
  it("raw_files → finished_files moves the link into Finished Work, keeps the URL and the history", () => {
    const raw = run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://www.dropbox.com/sh/finals", label: "Finals" }));
    const ctx = contextFor(db, ids.users.manager);
    expect(finishedWorkLinks(db, ctx, jobId)).toEqual([]);

    const updated = run(ids.users.manager, (tx, c) => updateLink(tx, c, { linkId: raw.id, kind: "finished_files" }));
    expect(updated).toMatchObject({ kind: "finished_files", url: raw.url, label: "Finals", supersedesLinkId: raw.id, provider: "dropbox" });
    expect(finishedWorkLinks(db, ctx, jobId).map((l) => l.id)).toEqual([updated.id]);
    const slots = listLinks(db, ctx, jobId, { history: true });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ kind: "finished_files", current: { id: updated.id } });
    expect(slots[0].history.map((h) => h.kind)).toEqual(["raw_files", "finished_files"]);
    expect(db.select().from(jobLinks).where(eq(jobLinks.id, raw.id)).get()).toMatchObject({ kind: "raw_files", supersededByLinkId: updated.id });
  });

  it("writes link.updated with before/after {kind,label}", () => {
    const link = run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/ref", label: "Moodboard" }));
    const updated = run(ids.users.photographer1, (tx, ctx) => updateLink(tx, ctx, { linkId: link.id, kind: "other", label: "Brief" }));
    const evt = db.select().from(activityEvents).where(and(eq(activityEvents.jobId, jobId), eq(activityEvents.eventType, "link.updated"))).get();
    expect(evt).toMatchObject({
      entityType: "link",
      entityId: updated.id,
      action: "updated",
      previousValue: { linkId: link.id, kind: "reference", label: "Moodboard" },
      newValue: { linkId: updated.id, kind: "other", label: "Brief" },
    });
    expect(evt?.summary).toContain("moved a link from reference material to other");
    expect(updated.activityEventId).toBe(evt?.id);
  });

  it("enforces the editor link-kind rules for the new kind; stale links are 409", () => {
    const own = run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "editing_workspace", url: "https://frame.io/p/1" }));
    // editors may not file links as raw_files / client_delivery
    expect(status(() => run(ids.users.editor1, (tx, ctx) => updateLink(tx, ctx, { linkId: own.id, kind: "raw_files" })))).toBe(403);
    // allowed kind works
    const moved = run(ids.users.editor1, (tx, ctx) => updateLink(tx, ctx, { linkId: own.id, kind: "finished_files" }));
    expect(moved.kind).toBe("finished_files");
    // the superseded row can no longer be edited
    expect(status(() => run(ids.users.editor1, (tx, ctx) => updateLink(tx, ctx, { linkId: own.id, label: "x" })))).toBe(409);
    // someone else's link (link.replace: editors only their own)
    const photogs = run(ids.users.photographer1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://pixieset.com/g" }));
    expect(status(() => run(ids.users.editor1, (tx, ctx) => updateLink(tx, ctx, { linkId: photogs.id, label: "Mine" })))).toBe(403);
    // nothing to change
    expect(status(() => run(ids.users.manager, (tx, ctx) => updateLink(tx, ctx, { linkId: photogs.id })))).toBe(400);
  });
});
