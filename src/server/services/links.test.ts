import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, jobLinks } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
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

  it("addLink rejects disallowed protocols with a ValidationError", () => {
    expect(() => run(ids.users.manager, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "javascript:alert(1)" }))).toThrow(
      ValidationError,
    );
  });
});

describe("supersession chain", () => {
  it("replace keeps history: old rows fill superseded_at/by once, new rows point back", () => {
    const v1 = run(ids.users.photographer1, (tx, ctx) =>
      addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://www.dropbox.com/raw-1", label: "Raws" }),
    );
    expect(v1).toMatchObject({ provider: "dropbox", addedByUserId: ids.users.photographer1, supersedesLinkId: null });
    expect(v1.activityEventId).toBeTruthy();

    fakeClock.advanceMinutes(10);
    const r2 = run(ids.users.photographer1, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://drive.google.com/raw-2" }));
    expect(r2.link).toMatchObject({ supersedesLinkId: v1.id, label: "Raws", provider: "drive", kind: "raw_files" });
    expect(r2.previous).toMatchObject({ id: v1.id, supersededByLinkId: r2.link.id, supersededAt: fakeClock.now() });

    fakeClock.advanceMinutes(10);
    const r3 = run(ids.users.manager, (tx, ctx) => replaceLink(tx, ctx, { linkId: r2.link.id, url: "https://we.tl/raw-3", label: null }));
    expect(r3.link.label).toBeNull();

    const current = listLinks(db, contextFor(db, ids.users.editor1), jobId);
    expect(current).toHaveLength(1);
    expect(current[0].current?.id).toBe(r3.link.id);
    expect(current[0].history.map((h) => h.id)).toEqual([r3.link.id]);

    const withHistory = listLinks(db, contextFor(db, ids.users.editor1), jobId, { history: true });
    expect(withHistory[0].history.map((h) => h.url)).toEqual([
      "https://www.dropbox.com/raw-1",
      "https://drive.google.com/raw-2",
      "https://we.tl/raw-3",
    ]);
    expect(withHistory[0].history.map((h) => h.isCurrent)).toEqual([false, false, true]);

    const replaced = db.select().from(activityEvents).where(eq(activityEvents.eventType, "link.replaced")).all();
    expect(replaced).toHaveLength(2);
    expect(replaced[0].previousValue).toMatchObject({ linkId: v1.id, url: "https://www.dropbox.com/raw-1" });
    expect(replaced[0].metadata).toMatchObject({ kind: "raw_files", supersedesLinkId: v1.id });
  });

  it("a superseded or removed link cannot be replaced again (409)", () => {
    const v1 = run(ids.users.manager, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com/1" }));
    run(ids.users.manager, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/2" }));
    expect(() => run(ids.users.manager, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/3" }))).toThrow(
      ConflictError,
    );
    expect(() => run(ids.users.manager, (tx, ctx) => removeLink(tx, ctx, { linkId: v1.id }))).toThrow(ConflictError);
  });

  it("the DB refuses to rewrite link content or re-fill supersession", () => {
    const v1 = run(ids.users.manager, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com/1" }));
    expect(() => db.update(jobLinks).set({ url: "https://evil.example" }).where(eq(jobLinks.id, v1.id)).run()).toThrow();
    run(ids.users.manager, (tx, ctx) => replaceLink(tx, ctx, { linkId: v1.id, url: "https://example.com/2" }));
    expect(() => db.update(jobLinks).set({ supersededAt: "2030-01-01T00:00:00.000Z" }).where(eq(jobLinks.id, v1.id)).run()).toThrow();
  });

  it("removeLink fills removed_* once; the slot only shows with history", () => {
    const v1 = run(ids.users.manager, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/ref" }));
    const removed = run(ids.users.manager, (tx, ctx) => removeLink(tx, ctx, { linkId: v1.id, reason: "Wrong job" }));
    expect(removed).toMatchObject({ removedByUserId: ids.users.manager, removeReason: "Wrong job" });
    expect(listLinks(db, contextFor(db, ids.users.manager), jobId)).toHaveLength(0);
    const hist = listLinks(db, contextFor(db, ids.users.manager), jobId, { history: true });
    expect(hist).toHaveLength(1);
    expect(hist[0].current).toBeNull();
    expect(hist[0].history[0].removedBy?.id).toBe(ids.users.manager);
    const ev = db.select().from(activityEvents).where(eq(activityEvents.eventType, "link.removed")).get();
    expect(ev?.metadata).toMatchObject({ reason: "Wrong job" });
  });
});

describe("link permissions", () => {
  it("editors add only EDITOR_LINK_KINDS on assigned jobs and change only their own links", () => {
    expect(() => run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "raw_files", url: "https://example.com" }))).toThrow(
      ForbiddenError,
    );
    expect(() =>
      run(ids.users.editor2, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://example.com" })),
    ).toThrow(ForbiddenError);
    const own = run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://f.io/1" }));
    const photographers = run(ids.users.photographer1, (tx, ctx) =>
      addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/ref" }),
    );
    expect(() => run(ids.users.editor1, (tx, ctx) => replaceLink(tx, ctx, { linkId: photographers.id, url: "https://example.com/x" }))).toThrow(
      ForbiddenError,
    );
    expect(run(ids.users.editor1, (tx, ctx) => replaceLink(tx, ctx, { linkId: own.id, url: "https://f.io/2" })).link.provider).toBe("frameio");
  });

  it("foreign link ids are 404", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    const foreignJob = insertJobFixture(db, other, { statusKey: "in_progress" }).job.id;
    const foreign = withTx((tx) => addLink(tx, contextFor(db, other.users.manager), { jobId: foreignJob, kind: "raw_files", url: "https://example.com" }), {
      db,
    });
    expect(() => run(ids.users.owner, (tx, ctx) => removeLink(tx, ctx, { linkId: foreign.id }))).toThrow(NotFoundError);
    expect(() => listLinks(db, contextFor(db, ids.users.owner), foreignJob)).toThrow(NotFoundError);
  });
});

describe("engine helpers", () => {
  it("hasCurrentLinkOfKind / linkWarningsForTransition / finishedWorkLinks follow current rows only", () => {
    expect(linkWarningsForTransition(db, jobId, "submitted").map((w) => w.code)).toEqual(["missing_finished_work"]);
    expect(linkWarningsForTransition(db, jobId, "delivered").map((w) => w.code)).toEqual(["missing_delivery_link"]);
    expect(linkWarningsForTransition(db, jobId, "review")).toEqual([]);

    const ws = run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "editing_workspace", url: "https://lightroom.adobe.com/x" }));
    expect(hasCurrentLinkOfKind(db, jobId, "editing_workspace")).toBe(true);
    expect(linkWarningsForTransition(db, jobId, "submitted")).toEqual([]);

    run(ids.users.editor1, (tx, ctx) => removeLink(tx, ctx, { linkId: ws.id }));
    expect(hasCurrentLinkOfKind(db, jobId, ["editing_workspace", "finished_files"])).toBe(false);

    run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "gallery", url: "https://studio.pixieset.com/g" }));
    run(ids.users.editor1, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "reference", url: "https://example.com/r" }));
    const finished = finishedWorkLinks(db, contextFor(db, ids.users.photographer1), jobId);
    expect(finished.map((l) => l.kind)).toEqual(["gallery"]);
    expect(linkWarningsForTransition(db, jobId, "delivered")).toEqual([]);
  });
});
