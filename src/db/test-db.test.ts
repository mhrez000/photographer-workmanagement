import fs from "node:fs";
import path from "node:path";
import { count, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { GUARDS, ROW_GUARDS, listInstalledGuards } from "./guard";
import { execRows, RootDbInTransactionError } from "./index";
import { verifyDerived } from "./verify";
import {
  addTeamFixture,
  contextFor,
  dbRejection,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  testPasswordHash,
  type TestDb,
} from "./test-db";
import { DEFAULT_JOB_TYPES, DEFAULT_WORKFLOW_STATUSES, DEFAULT_WORKFLOW_TRANSITIONS, STATUS_CATEGORY_META } from "@/lib/constants";
import { verifyPassword } from "@/server/auth/password";

async function publicTables(db: TestDb): Promise<string[]> {
  const rows = await execRows<{ name: string }>(
    db,
    sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return rows.map((r) => r.name);
}

describe("makeTestDb", () => {
  it("creates every table of the schema and installs every guard trigger", async () => {
    const db = await makeTestDb();
    const tables = await publicTables(db);
    expect(tables).toHaveLength(28);
    expect(tables).toContain("activity_events");
    expect(tables.sort()).toEqual([...schema.TABLE_NAMES].sort());
    expect(ROW_GUARDS).toHaveLength(33);
    expect(ROW_GUARDS.map((g) => g.name)).toEqual(expect.arrayContaining(["users_keep_admin", "users_client_link", "org_primary_owner", "at_no_delete", "at_fill_once"]));
    expect((await listInstalledGuards(db)).sort()).toEqual(GUARDS.map((g) => g.name).sort());
    // FKs are enforced (restrict): a job type pointing at a missing workflow is rejected.
    expect(
      await dbRejection(
        db.insert(schema.jobTypes).values({ organisationId: "nope", name: "x", workflowId: "missing" }),
      ),
    ).toMatch(/foreign key/);
  });

  it("returns isolated databases", async () => {
    const a = await makeTestDb();
    const b = await makeTestDb();
    await seedMinimalOrg(a);
    expect((await a.select({ n: count() }).from(schema.users))[0]?.n).toBe(10);
    expect((await b.select({ n: count() }).from(schema.users))[0]?.n).toBe(0);
  });

  it("throws instead of deadlocking when the root db is used inside a transaction", async () => {
    const db = await makeTestDb();
    await expect(
      db.transaction(async () => {
        await db.select().from(schema.users);
      }),
    ).rejects.toBeInstanceOf(RootDbInTransactionError);
    // the handle is still usable afterwards
    expect(await db.select().from(schema.users)).toEqual([]);
  });

  it("committed drizzle migrations are in sync with src/db/schema.ts (run `npx drizzle-kit generate` if this fails)", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const metaDir = path.resolve(process.cwd(), "drizzle", "meta");
    const journal = JSON.parse(fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8")) as { entries: { idx: number }[] };
    const lastIdx = Math.max(...journal.entries.map((e) => e.idx));
    const snapshotFile = path.join(metaDir, `${String(lastIdx).padStart(4, "0")}_snapshot.json`);
    const previous = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as Parameters<typeof generateMigration>[0];
    const current = generateDrizzleJson(schema as unknown as Record<string, unknown>, previous.id);
    const statements = await generateMigration(previous, current);
    expect(statements).toEqual([]);
  }, 30_000);
});

describe("seedMinimalOrg", () => {
  let db: TestDb;
  beforeEach(async () => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    db = await makeTestDb();
  });
  afterEach(() => fakeClock.reset());

  it("creates the org, settings, 10 persona users, default workflow, job types, clients and projects with known ids", async () => {
    const ids = await seedMinimalOrg(db);
    expect(ids.organisationId).toBe("studio-org");
    expect(ids.users.owner).toBe("studio-owner");
    expect(ids.emails.owner).toBe("owner@studio.test");
    expect(ids.emails.coAdmin).toBe("coadmin@studio.test");
    expect(ids.emails.lead).toBe("lead@studio.test");
    expect(ids.emails.editor1).toBe("editor01@studio.test");
    expect(ids.emails.client).toBe("client@studio.test");
    expect(ids.emails.client2).toBe("client2@studio.test");

    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(10);
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(byId.get(ids.users.owner)).toMatchObject({ role: "photographer", isAdmin: true });
    expect(byId.get(ids.users.coAdmin)).toMatchObject({ role: "photographer", isAdmin: true });
    expect(byId.get(ids.users.lead)).toMatchObject({ role: "photographer", isAdmin: false, canViewAllJobs: true, canViewAnalytics: true, canViewTeamWorkloads: true });
    expect(byId.get(ids.users.photographer1)).toMatchObject({ isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false });
    expect(byId.get(ids.users.client)).toMatchObject({ role: "client", clientId: ids.clientId });
    expect(byId.get(ids.users.client2)).toMatchObject({ role: "client", clientId: ids.clientId2 });
    expect((await db.select().from(schema.organisationSettings))[0]?.primaryOwnerUserId).toBe(ids.users.owner);
    expect(users.filter((u) => !u.isActive).map((u) => u.id)).toEqual([ids.users.inactiveEditor]);
    expect((await db.select().from(schema.organisationSettings))[0]?.timezone).toBe("Australia/Sydney");

    const statuses = await db.select().from(schema.workflowStatuses);
    expect(statuses).toHaveLength(DEFAULT_WORKFLOW_STATUSES.length);
    expect(statuses.filter((s) => s.isInitial).map((s) => s.key)).toEqual(["new"]);
    const activeCount = DEFAULT_WORKFLOW_STATUSES.filter((s) => STATUS_CATEGORY_META[s.category].open).length;
    const transitions = await db.select().from(schema.workflowTransitions);
    expect(transitions).toHaveLength(DEFAULT_WORKFLOW_TRANSITIONS.length + activeCount);
    expect(ids.transitions["in_progress->cancelled"]).toBeDefined();
    expect(ids.transitions["completed->cancelled"]).toBeUndefined();
    expect(Object.keys(ids.jobTypes)).toHaveLength(DEFAULT_JOB_TYPES.length);
    const projects = await db.select().from(schema.projects);
    expect(projects.find((p) => p.id === ids.projectId)?.clientId).toBe(ids.clientId);
    expect(projects.find((p) => p.id === ids.projectId2)?.clientId).toBe(ids.clientId2);
  });

  it("can seed a second organisation alongside (cross-org tests)", async () => {
    const a = await seedMinimalOrg(db);
    const b = await seedMinimalOrg(db, { slug: "other" });
    expect(b.emails.owner).toBe("owner@other.test");
    expect(a.organisationId).not.toBe(b.organisationId);
    expect((await db.select({ n: count() }).from(schema.organisations))[0]?.n).toBe(2);
  });

  it("stores a bcrypt hash that verifies TEST_PASSWORD", async () => {
    const ids = await seedMinimalOrg(db);
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, ids.users.owner));
    expect(owner?.passwordHash).toBe(testPasswordHash());
    expect(await verifyPassword(ids.password, owner?.passwordHash ?? "")).toBe(true);
  });
});

describe("insertJobFixture", () => {
  let db: TestDb;
  beforeEach(async () => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    db = await makeTestDb();
  });
  afterEach(() => fakeClock.reset());

  it("inserts a job in every default status that satisfies the triggers and db:verify (zero drift)", async () => {
    const ids = await seedMinimalOrg(db);
    for (const s of DEFAULT_WORKFLOW_STATUSES) {
      fakeClock.advanceMinutes(5);
      const { job } = await insertJobFixture(db, ids, { statusKey: s.key, dueDate: "2026-10-12T12:59:59.999Z" });
      expect(job.statusCategory).toBe(s.category);
    }
    const report = await verifyDerived(db);
    expect(report.jobsChecked).toBe(DEFAULT_WORKFLOW_STATUSES.length);
    expect(report.drift).toEqual([]);
    expect(report.structural).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("allocates gap-free job numbers and writes the creation ledger + event", async () => {
    const ids = await seedMinimalOrg(db);
    const first = await insertJobFixture(db, ids);
    const second = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 });
    expect(first.job.jobNumber).toBe("PJ-0001");
    expect(second.job.jobNumber).toBe("PJ-0002");
    expect(second.job.editorId).toBe(ids.users.editor2);
    expect(second.assignmentIds.editor).not.toBeNull();
    expect(first.job.editorId).toBeNull();

    const rows = await db.select().from(schema.jobStatusTransitions).where(eq(schema.jobStatusTransitions.jobId, second.job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 1, kind: "creation", exitedAt: null, activityEventId: second.eventId });
    const [event] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.id, second.eventId));
    expect(event).toMatchObject({ eventType: "job.created", jobId: second.job.id, actorUserId: ids.users.photographer1 });
    expect(event?.summary).toBe(`created job PJ-0002 “${second.job.name}”`);
  });

  it("contextFor builds a usable context and teams are opt-in", async () => {
    const ids = await seedMinimalOrg(db);
    expect((await contextFor(db, ids.users.editor1)).teamUserIds.size).toBe(0);
    await addTeamFixture(db, ids, { name: "Crew", memberIds: [ids.users.editor1, ids.users.photographer1] });
    const ctx = await contextFor(db, ids.users.editor1);
    expect([...ctx.teamUserIds]).toEqual([ids.users.photographer1]);
    expect(ctx.now()).toBe("2026-10-08T00:00:00.000Z");
    await expect(contextFor(db, ids.users.inactiveEditor)).rejects.toThrow(/inactive/);
  });
});
