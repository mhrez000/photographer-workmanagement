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

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

async function eventsFor(entityId: string) {
  return await db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId)).orderBy(activityEvents.rowid);
}

describe("clients", () => {
  it("creates a client with an audit event; editors cannot", async () => {
    const client = await run(ids.users.photographer1, (tx, ctx) => createClient(tx, ctx, { name: "  Bay Agency ", email: "Hi@Bay.test", phone: "" }));
    expect(client).toMatchObject({ name: "Bay Agency", email: "hi@bay.test", phone: null, createdByUserId: ids.users.photographer1, version: 1 });
    const events = await eventsFor(client.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "client.created", action: "created", actorUserId: ids.users.photographer1 });
    expect(events[0].summary).toContain("Bay Agency");

    await expect(run(ids.users.editor1, (tx, ctx) => createClient(tx, ctx, { name: "Nope" }))).rejects.toThrow(ForbiddenError);
  });

  it("validates input", async () => {
    await expect(run(ids.users.coAdmin, (tx, ctx) => createClient(tx, ctx, { name: "" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => createClient(tx, ctx, { name: "X", email: "not-an-email" }))).rejects.toThrow(ValidationError);
  });

  it("photographers edit only clients they created; admins edit any", async () => {
    const own = await run(ids.users.photographer1, (tx, ctx) => createClient(tx, ctx, { name: "Own" }));
    const updated = await run(ids.users.photographer1, (tx, ctx) => updateClient(tx, ctx, { clientId: own.id, notes: "VIP", expectedVersion: 1 }));
    expect(updated).toMatchObject({ notes: "VIP", version: 2 });
    const ev = (await eventsFor(own.id)).find((e) => e.eventType === "client.updated");
    expect(ev?.previousValue).toEqual({ notes: null });
    expect(ev?.newValue).toEqual({ notes: "VIP" });

    // fixture client was created by the owner (another admin may still edit it)
    await expect(run(ids.users.photographer1, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Hijack" }))).rejects.toThrow(ForbiddenError);
    expect((await run(ids.users.coAdmin, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Harbour Realty Group" }))).name).toBe(
      "Harbour Realty Group",
    );
  });

  it("no-op updates write nothing; stale versions conflict", async () => {
    const before = (await eventsFor(ids.clientId)).length;
    const same = await run(ids.users.coAdmin, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "Harbour Realty" }));
    expect(same.version).toBe(1);
    expect(await eventsFor(ids.clientId)).toHaveLength(before);
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateClient(tx, ctx, { clientId: ids.clientId, name: "X", expectedVersion: 7 }))).rejects.toThrow(
      ConflictError,
    );
  });

  it("foreign ids are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateClient(tx, ctx, { clientId: other.clientId, name: "X" }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: other.clientId }))).rejects.toThrow(NotFoundError);
  });

  it("archive is admin-only and blocked while the client has active jobs", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await expect(run(ids.users.photographer1, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }))).rejects.toThrow(/1 active job/);

    const fresh = await run(ids.users.coAdmin, (tx, ctx) => createClient(tx, ctx, { name: "Quiet" }));
    const archived = await run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: fresh.id, expectedVersion: 1 }));
    expect(archived.archivedAt).toBe("2026-10-08T00:00:00.000Z");
    await expect(run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: fresh.id }))).rejects.toThrow(ValidationError);
    // archived client: no new projects
    await expect(run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: fresh.id, name: "P" }))).rejects.toThrow(/archived/);

    const restored = await run(ids.users.owner, (tx, ctx) => restoreClient(tx, ctx, { clientId: fresh.id }));
    expect(restored.archivedAt).toBeNull();
    expect((await eventsFor(fresh.id)).map((e) => e.eventType)).toEqual(["client.created", "client.archived", "client.restored"]);
  });

  it("completed and cancelled jobs do not block archiving", async () => {
    await insertJobFixture(db, ids, { statusKey: "completed" });
    await insertJobFixture(db, ids, { statusKey: "cancelled" });
    const row = await run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: ids.clientId }));
    expect(row.archivedAt).not.toBeNull();
  });
});

describe("projects", () => {
  it("creates a project under a client; civil dates are stored as end of day in the org timezone", async () => {
    const p = await run(ids.users.photographer1, (tx, ctx) =>
      createProject(tx, ctx, { clientId: ids.clientId, name: "9 Ocean Ave", startDate: "2026-10-10", endDate: "2026-10-12T05:00:00.000Z" }),
    );
    expect(p.clientId).toBe(ids.clientId);
    // end of 2026-10-10 in Sydney (UTC+11 in October) = 2026-10-10T13:00Z (exclusive bound per dates.ts)
    expect(p.startDate).toBe("2026-10-10T12:59:59.999Z");
    expect(p.endDate).toBe("2026-10-12T05:00:00.000Z");
    expect((await eventsFor(p.id))[0]).toMatchObject({ eventType: "project.created" });
  });

  it("rejects end before start and foreign clients", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(
      run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "X", startDate: "2026-10-10", endDate: "2026-10-01" })),
    ).rejects.toThrow(/End date/);
    await expect(run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: other.clientId, name: "X" }))).rejects.toThrow(NotFoundError);
  });

  it("a project with jobs cannot move to another client; an empty one can", async () => {
    await insertJobFixture(db, ids, { statusKey: "new" });
    const c2 = await run(ids.users.coAdmin, (tx, ctx) => createClient(tx, ctx, { name: "Second" }));
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateProject(tx, ctx, { projectId: ids.projectId, clientId: c2.id }))).rejects.toThrow(/1 job/);

    const empty = await run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Empty" }));
    const moved = await run(ids.users.coAdmin, (tx, ctx) => updateProject(tx, ctx, { projectId: empty.id, clientId: c2.id, expectedVersion: 1 }));
    expect(moved).toMatchObject({ clientId: c2.id, version: 2 });
    const ev = (await eventsFor(empty.id)).find((e) => e.eventType === "project.updated");
    expect(ev?.metadata).toMatchObject({ fromLabel: "Harbour Realty", toLabel: "Second" });
  });

  it("photographers edit only their own projects", async () => {
    await expect(run(ids.users.photographer1, (tx, ctx) => updateProject(tx, ctx, { projectId: ids.projectId, name: "X" }))).rejects.toThrow(ForbiddenError);
    const mine = await run(ids.users.photographer1, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Mine" }));
    expect((await run(ids.users.photographer1, (tx, ctx) => updateProject(tx, ctx, { projectId: mine.id, address: "1 Main St" }))).address).toBe("1 Main St");
  });

  it("archive blocked by active jobs; restore needs an active client; resolveProjectForJob rejects archived rows", async () => {
    const job = await insertJobFixture(db, ids, { statusKey: "submitted" });
    await expect(run(ids.users.coAdmin, (tx, ctx) => archiveProject(tx, ctx, { projectId: ids.projectId }))).rejects.toThrow(/active job/);
    expect(job.job.projectId).toBe(ids.projectId);

    const p = await run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: ids.clientId, name: "Short" }));
    await run(ids.users.coAdmin, (tx, ctx) => archiveProject(tx, ctx, { projectId: p.id }));
    await expect(run(ids.users.coAdmin, (tx, ctx) => resolveProjectForJob(tx, ctx, p.id))).rejects.toThrow(/archived/);
    await expect(run(ids.users.editor1, (tx, ctx) => archiveProject(tx, ctx, { projectId: p.id }))).rejects.toThrow(ForbiddenError);

    // archive the client of an archived project → restoring the project is blocked
    const c2 = await run(ids.users.coAdmin, (tx, ctx) => createClient(tx, ctx, { name: "Gone" }));
    const p2 = await run(ids.users.coAdmin, (tx, ctx) => createProject(tx, ctx, { clientId: c2.id, name: "Gone project" }));
    await run(ids.users.coAdmin, (tx, ctx) => archiveProject(tx, ctx, { projectId: p2.id }));
    await run(ids.users.coAdmin, (tx, ctx) => archiveClient(tx, ctx, { clientId: c2.id }));
    await expect(run(ids.users.coAdmin, (tx, ctx) => restoreProject(tx, ctx, { projectId: p2.id }))).rejects.toThrow(/client/);

    const restored = await run(ids.users.owner, (tx, ctx) => restoreProject(tx, ctx, { projectId: p.id }));
    expect(restored.archivedAt).toBeNull();
    const resolved = await run(ids.users.coAdmin, (tx, ctx) => resolveProjectForJob(tx, ctx, p.id));
    expect(resolved.client.id).toBe(ids.clientId);
  });

  it("writes nothing when a later step throws (single transaction)", async () => {
    const before = (await db.select().from(projects)).length;
    const ctx = await contextFor(db, ids.users.coAdmin);
    await expect(
      withTx(
        async (tx) => {
          await createProject(tx, ctx, { clientId: ids.clientId, name: "Rolled back" });
          throw new Error("boom");
        },
        { db },
      ),
    ).rejects.toThrow("boom");
    expect(await db.select().from(projects)).toHaveLength(before);
    expect(
      await db
        .select()
        .from(activityEvents)
        .where(and(eq(activityEvents.eventType, "project.created"))),
    ).toHaveLength(0);
    expect(await db.select().from(clients)).toHaveLength(2); // the two fixture clients (clientId, clientId2)
  });
});
