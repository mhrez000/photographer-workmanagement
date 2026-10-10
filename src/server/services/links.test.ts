import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobLinks } from "@/db/schema";
import { contextFor, dbRejection, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { deriveLinkProvider, isAllowedLinkUrl } from "@/lib/validation/links";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  addLink,
  finishedWorkLinks,
  hasCurrentLinkOfKind,
  linkWarningsForTransition,
  listLinks,
  removeLink,
  replaceLink,
} from "./links";

let db: TestDb;
let ids: SeedIds;
let jobId: string;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  jobId = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job.id;
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

describe("provider derivation + URL allowlist", () => {
  it.each([
    ["https://drive.google.com/drive/folders/abc", "drive"],
    ["https://docs.google.com/document/d/1", "drive"],
    ["https://www.dropbox.com/scl/fo/xyz", "dropbox"],
    ["https://1drv.ms/f/s!abc", "onedrive"],
    ["https://contoso.sharepoint.com/sites/x", "onedrive"],
    ["https://app.frame.io/reviews/123", "frameio"],
    ["https://f.io/AbC", "frameio"],
    ["https://we.tl/t-123", "wetransfer"],
    ["https://wetransfer.com/downloads/1", "wetransfer"],
    ["https://lightroom.adobe.com/shares/1", "lightroom"],
    ["https://studio.pixieset.com/gallery", "pixieset"],
    ["https://DRIVE.GOOGLE.COM/x", "drive"],
    ["https://notdropbox.com/x", "other"],
    ["https://dropbox.com.evil.example/x", "other"],
    ["https://example.com", "other"],
  ])("%s → %s", (url, provider) => {
    expect(deriveLinkProvider(url)).toBe(provider);
  });

  it("accepts http(s) only and rejects embedded credentials", () => {
    expect(isAllowedLinkUrl("https://example.com/a")).toBe(true);
    expect(isAllowedLinkUrl("http://example.com")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "file:///etc/passwd", "example.com", "https://u:p@example.com"]) {
      expect(isAllowedLinkUrl(bad)).toBe(false);
    }
  });

  it("addLink rejects disallowed protocols with a ValidationError", async () => {
    await expect(
      run(ids.users.coAdmin, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "javascript:alert(1)" })),
    ).rejects.toThrow(ValidationError);
  });
});

describe("supersession chain", () => {
  it("replace keeps history: old rows fill superseded_at/by once, new rows point back", async () => {
    const v1 = await run(ids.users.photographer1, (tx, ctx) =>
      addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://www.dropbox.com/raw-1", label: "Raws" }),
    );
    expect(v1).toMatchObject({ provider: "dropbox", addedByUserId: ids.users.photographer1, supersedesLinkId: null });
    expect(v1.activityEventId).toBeTruthy();

    fakeClock.advanceMinutes(10);
    const r2 = await run(ids.users.photographer1, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://drive.google.com/raw-2" }));
    expect(r2.link).toMatchObject({ supersedesLinkId: v1.id, label: "Raws", provider: "drive", kind: "raw_files" });
    expect(r2.previous).toMatchObject({ id: v1.id, supersededByLinkId: r2.link.id, supersededAt: fakeClock.now() });

    fakeClock.advanceMinutes(10);
    const r3 = await run(ids.users.coAdmin, (tx, ctx) => replaceLink(tx, ctx, { linkId: r2.link.id, url: "https://we.tl/raw-3", label: null }));
    expect(r3.link.label).toBeNull();

    const current = await listLinks(db, await contextFor(db, ids.users.editor1), jobId);
    expect(current).toHaveLength(1);
    expect(current[0].current?.id).toBe(r3.link.id);
    expect(current[0].history.map((h) => h.id)).toEqual([r3.link.id]);

    const withHistory = await listLinks(db, await contextFor(db, ids.users.editor1), jobId, { history: true });
    expect(withHistory[0].history.map((h) => h.url)).toEqual([
      "https://www.dropbox.com/raw-1",
      "https://drive.google.com/raw-2",
      "https://we.tl/raw-3",
    ]);
    expect(withHistory[0].history.map((h) => h.isCurrent)).toEqual([false, false, true]);

    const replaced = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "link.replaced"))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
    expect(replaced).toHaveLength(2);
    expect(replaced[0].previousValue).toMatchObject({ linkId: v1.id, url: "https://www.dropbox.com/raw-1" });
    expect(replaced[0].metadata).toMatchObject({ kind: "raw_files", supersedesLinkId: v1.id });
  });

  it("a superseded or removed link cannot be replaced again (409)", async () => {
    const v1 = await run(ids.users.coAdmin, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com/1" }));
    await run(ids.users.coAdmin, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/2" }));
    await expect(
      run(ids.users.coAdmin, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/3" })),
    ).rejects.toThrow(ConflictError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => removeLink(tx, ctx, { linkId: v1.id }))).rejects.toThrow(ConflictError);
  });

  it("the DB refuses to rewrite link content or re-fill supersession", async () => {
    const v1 = await run(ids.users.coAdmin, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com/1" }));
    expect(await dbRejection(db.update(jobLinks).set({ url: "https://evil.example" }).where(eq(jobLinks.id, v1.id)))).toMatch(/link rows are immutable/);
    await run(ids.users.coAdmin, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/2" }));
    expect(
      await dbRejection(db.update(jobLinks).set({ supersededAt: "2030-01-01T00:00:00.000Z" }).where(eq(jobLinks.id, v1.id))),
    ).toMatch(/link rows are immutable/);
  });

  it("removeLink fills removed_* once; the slot only shows with history", async () => {
    const v1 = await run(ids.users.coAdmin, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/ref" }));
    const removed = await run(ids.users.coAdmin, (tx, ctx) => removeLink(tx, ctx, { linkId: v1.id, reason: "Wrong job" }));
    expect(removed).toMatchObject({ removedByUserId: ids.users.coAdmin, removeReason: "Wrong job" });
    expect(await listLinks(db, await contextFor(db, ids.users.coAdmin), jobId)).toHaveLength(0);
    const hist = await listLinks(db, await contextFor(db, ids.users.coAdmin), jobId, { history: true });
    expect(hist).toHaveLength(1);
    expect(hist[0].current).toBeNull();
    expect(hist[0].history[0].removedBy?.id).toBe(ids.users.coAdmin);
    const ev = await first(db.select().from(activityEvents).where(eq(activityEvents.eventType, "link.removed")).limit(1));
    expect(ev?.metadata).toMatchObject({ reason: "Wrong job" });
  });
});

describe("link permissions", () => {
  it("editors add only EDITOR_LINK_KINDS on assigned jobs and change only their own links", async () => {
    await expect(
      run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com" })),
    ).rejects.toThrow(ForbiddenError);
    // editor2 cannot see the job → 404 (no existence oracle)
    await expect(
      run(ids.users.editor2, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://example.com" })),
    ).rejects.toThrow(NotFoundError);
    const own = await run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://f.io/1" }));
    const photographers = await run(ids.users.photographer1, (tx, ctx) =>
      addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/ref" }),
    );
    await expect(
      run(ids.users.editor1, (tx, ctx) => replaceLink(tx, ctx, { linkId: photographers.id, url: "https://example.com/x" })),
    ).rejects.toThrow(ForbiddenError);
    expect((await run(ids.users.editor1, (tx, ctx) => replaceLink(tx, ctx, { linkId: own.id, url: "https://f.io/2" }))).link.provider).toBe(
      "frameio",
    );
  });

  it("foreign link ids are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreignJob = (await insertJobFixture(db, other, { statusKey: "in_progress" })).job.id;
    const otherManager = await contextFor(db, other.users.coAdmin);
    const foreign = await withTx((tx) => addLink(tx, otherManager, { jobId: foreignJob, kind: "raw_files", url: "https://example.com" }), {
      db,
    });
    await expect(run(ids.users.owner, (tx, ctx) => removeLink(tx, ctx, { linkId: foreign.id }))).rejects.toThrow(NotFoundError);
    await expect(listLinks(db, await contextFor(db, ids.users.owner), foreignJob)).rejects.toThrow(NotFoundError);
  });
});

describe("engine helpers", () => {
  it("hasCurrentLinkOfKind / linkWarningsForTransition / finishedWorkLinks follow current rows only", async () => {
    expect((await linkWarningsForTransition(db, jobId, "submitted")).map((w) => w.code)).toEqual(["missing_finished_work"]);
    expect((await linkWarningsForTransition(db, jobId, "delivered")).map((w) => w.code)).toEqual(["missing_delivery_link"]);
    expect(await linkWarningsForTransition(db, jobId, "review")).toEqual([]);

    const ws = await run(ids.users.editor1, (tx, ctx) =>
      addLink(tx, ctx, { jobId, kind: "editing_workspace", url: "https://lightroom.adobe.com/x" }),
    );
    expect(await hasCurrentLinkOfKind(db, jobId, "editing_workspace")).toBe(true);
    expect(await linkWarningsForTransition(db, jobId, "submitted")).toEqual([]);

    await run(ids.users.editor1, (tx, ctx) => removeLink(tx, ctx, { linkId: ws.id }));
    expect(await hasCurrentLinkOfKind(db, jobId, ["editing_workspace", "finished_files"])).toBe(false);

    await run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://studio.pixieset.com/g" }));
    await run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/r" }));
    const finished = await finishedWorkLinks(db, await contextFor(db, ids.users.photographer1), jobId);
    expect(finished.map((l) => l.kind)).toEqual(["gallery"]);
    expect(await linkWarningsForTransition(db, jobId, "delivered")).toEqual([]);
  });
});
