import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, clients, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { archiveClient, createClient, restoreClient, updateClient } from "./clients";
import { archiveProject, createProject, resolveProjectForJob, restoreProject, updateProject } from "./projects";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function eventsFor(entityId: string) {
  return db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId)).all();
}

describe("clients", () => {
  it("creates a client with an audit event; editors cannot", () => {
    const client = run(ids.users.photographer1, (tx, ctx) => createClient(tx, ctx, { name: "  Bay Agency ", email: "Hi@Bay.test", phone: "" }));
    expect(client).toMatchObject({ name: "Bay Agency", email: "hi@bay.test", phone: null, createdByUserId: ids.users.photographer1, version: 1 });
    const events = eventsFor(client.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "client.created", action: "created", actorUserId: ids.users.photographer1 });
    expect(events[0].summary).toContain("Bay Agency");

    expect(() => run(ids.users.editor1, (tx, ctx) => createClient(tx, ctx, { name: "Nope" }))).toThrow(ForbiddenError);
  });

  it("validates input", () => {
    expect(() => run(ids.users.manager, (tx, ctx) => createClient(tx, ctx, { name: "" }))).toThrow(ValidationError);
    expect(() => run(ids.users.manager, (tx, ctx) => createClient(tx, ctx, { name: "X", email: "not-an-email" }))).toThrow(ValidationError);
  });

  it("photographers edit only clients they created; managers edit any", () => {
    const own = run(ids.users.photographer1, (tx, ctx) => createClient(tx, ctx, { name: "Own" }));
    const updated = run(ids.users.photographer1, (tx, ctx) => updateClient(tx, ctx, { clientId: own.id, notes: "VIP", expectedVersion: 1 }));
    expect(updated).toMatchObject({ notes: "VIP", version: 2 });
    const ev = eventsFor(own.id).find((e) => e.eventType === "client.updated");
    expect(ev?.previousValue).toEqual({ notes: null });
    expect(ev?.newValue).toEqual({ notes: "VIP" });

    // fixture client was created by the manager
    expect(() => run(ids.users.photographer1, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Hijack" }))).toThrow(ForbiddenError);
    expect(run(ids.users.manager, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Harbour Realty Group" })).name).toBe(
      "Harbour Realty Group",
    );
  });

  it("no-op updates write nothing; stale versions conflict", () => {
    const before = eventsFor(ids.clientId).length;
    const same = run(ids.users.manager, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Harbour Realty" }));
    expect(same.version).toBe(1);
    expect(eventsFor(ids.clientId)).toHaveLength(before);
    expect(() => run(ids.users.manager, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "X", expectedVersion: 7 }))).toThrow(
      ConflictError,
    );
  });

  it("foreign ids are 404", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => run(ids.users.manager, (tx, ctx) => updateClient(tx, ctx, { clientId: other.clientId, name: "X" }))).toThrow(NotFoundError);
    expect(() => run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: other.clientId }))).toThrow(NotFoundError);
  });

  it("archive is management-only and blocked while the client has active jobs", () => {
    insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect(() => run(ids.users.photographer1, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }))).toThrow(/1 active job/);

    const fresh = run(ids.users.manager, (tx, ctx) => createClient(tx, ctx, { name: "Quiet" }));
    const archived = run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: fresh.id, expectedVersion: 1 }));
    expect(archived.archivedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(() => run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: fresh.id }))).toThrow(ValidationError);
    // archived client: no new projects
    expect(() => run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: fresh.id, name: "P" }))).toThrow(/archived/);

    const restored = run(ids.users.owner, (tx, ctx) => restoreClient(tx, ctx, { clientId: fresh.id }));
    expect(restored.archivedAt).toBeNull();
    expect(eventsFor(fresh.id).map((e) => e.eventType)).toEqual(["client.created", "client.archived", "client.restored"]);
  });

  it("completed and cancelled jobs do not block archiving", () => {
    insertJobFixture(db, ids, { statusKey: "completed" });
    insertJobFixture(db, ids, { statusKey: "cancelled" });
    const row = run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }));
    expect(row.archivedAt).not.toBeNull();
  });
});

describe("projects", () => {
  it("creates a project under a client; civil dates are stored as end of day in the org timezone", () => {
    const p = run(ids.users.photographer1, (tx, ctx) =>
      createProject(tx, ctx, { clientId: ids.clientId, name: "9 Ocean Ave", startDate: "2026-10-10", endDate: "2026-10-12T05:00:00.000Z" }),
    );
    expect(p.clientId).toBe(ids.clientId);
    // end of 2026-10-10 in Sydney (UTC+11 in October) = 2026-10-10T13:00Z (exclusive bound per dates.ts)
    expect(p.startDate).toBe("2026-10-10T12:59:59.999Z");
    expect(p.endDate).toBe("2026-10-12T05:00:00.000Z");
    expect(eventsFor(p.id)[0]).toMatchObject({ eventType: "project.created" });
  });

  it("rejects end before start and foreign clients", () => {
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() =>
      run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "X", startDate: "2026-10-10", endDate: "2026-10-01" })),
    ).toThrow(/End date/);
    expect(() => run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: other.clientId, name: "X" }))).toThrow(NotFoundError);
  });

  it("a project with jobs cannot move to another client; an empty one can", () => {
    insertJobFixture(db, ids, { statusKey: "new" });
    const c2 = run(ids.users.manager, (tx, ctx) => createClient(tx, ctx, { name: "Second" }));
    expect(() => run(ids.users.manager, (tx, ctx) => updateProject(tx, ctx, { projectId: ids.projectId, clientId: c2.id }))).toThrow(/1 job/);

    const empty = run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Empty" }));
    const moved = run(ids.users.manager, (tx, ctx) => updateProject(tx, ctx, { projectId: empty.id, clientId: c2.id, expectedVersion: 1 }));
    expect(moved).toMatchObject({ clientId: c2.id, version: 2 });
    const ev = eventsFor(empty.id).find((e) => e.eventType === "project.updated");
    expect(ev?.metadata).toMatchObject({ fromLabel: "Harbour Realty", toLabel: "Second" });
  });

  it("photographers edit only their own projects", () => {
    expect(() => run(ids.users.photographer1, (tx, ctx) => updateProject(tx, ctx, { projectId: ids.projectId, name: "X" }))).toThrow(ForbiddenError);
    const mine = run(ids.users.photographer1, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Mine" }));
    expect(run(ids.users.photographer1, (tx, ctx) => updateProject(tx, ctx, { projectId: mine.id, address: "1 Main St" })).address).toBe("1 Main St");
  });

  it("archive blocked by active jobs; restore needs an active client; resolveProjectForJob rejects archived rows", () => {
    const job = insertJobFixture(db, ids, { statusKey: "submitted" });
    expect(() => run(ids.users.manager, (tx, ctx) => archiveProject(tx, ctx, { projectId: ids.projectId }))).toThrow(/active job/);
    expect(job.job.projectId).toBe(ids.projectId);

    const p = run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Short" }));
    run(ids.users.manager, (tx, ctx) => archiveProject(tx, ctx, { projectId: p.id }));
    expect(() => run(ids.users.manager, (tx, ctx) => resolveProjectForJob(tx, ctx, p.id))).toThrow(/archived/);
    expect(() => run(ids.users.editor1, (tx, ctx) => archiveProject(tx, ctx, { projectId: p.id }))).toThrow(ForbiddenError);

    // archive the client of an archived project → restoring the project is blocked
    const c2 = run(ids.users.manager, (tx, ctx) => createClient(tx, ctx, { name: "Gone" }));
    const p2 = run(ids.users.manager, (tx, ctx) => createProject(tx, ctx, { clientId: c2.id, name: "Gone project" }));
    run(ids.users.manager, (tx, ctx) => archiveProject(tx, ctx, { projectId: p2.id }));
    run(ids.users.manager, (tx, ctx) => archiveClient(tx, ctx, { clientId: c2.id }));
    expect(() => run(ids.users.manager, (tx, ctx) => restoreProject(tx, ctx, { projectId: p2.id }))).toThrow(/client/);

    const restored = run(ids.users.owner, (tx, ctx) => restoreProject(tx, ctx, { projectId: p.id }));
    expect(restored.archivedAt).toBeNull();
    const resolved = run(ids.users.manager, (tx, ctx) => resolveProjectForJob(tx, ctx, p.id));
    expect(resolved.client.id).toBe(ids.clientId);
  });

  it("writes nothing when a later step throws (single transaction)", () => {
    const before = db.select().from(projects).all().length;
    expect(() =>
      withTx(
        (tx) => {
          createProject(tx, contextFor(db, ids.users.manager), { clientId: ids.clientId, name: "Rolled back" });
          throw new Error("boom");
        },
        { db },
      ),
    ).toThrow("boom");
    expect(db.select().from(projects).all()).toHaveLength(before);
    expect(db.select().from(activityEvents).where(and(eq(activityEvents.eventType, "project.created"))).all()).toHaveLength(0);
    expect(db.select().from(clients).all()).toHaveLength(1);
  });
});
