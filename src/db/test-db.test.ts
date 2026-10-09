import Database from "better-sqlite3";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { GUARDS, listInstalledGuards } from "./guard";
import { verifyDerived } from "./verify";
import {
  addTeamFixture,
  contextFor,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  schemaStatements,
  seedMinimalOrg,
  testPasswordHash,
  type TestDb,
} from "./test-db";
import { DEFAULT_JOB_TYPES, DEFAULT_WORKFLOW_STATUSES, DEFAULT_WORKFLOW_TRANSITIONS, STATUS_CATEGORY_META } from "@/lib/constants";
import { verifyPassword } from "@/server/auth/password";

function shape(sqlite: Database.Database) {
  const tables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
    name: string;
  }[]).map((t) => t.name);
  const columns = Object.fromEntries(
    tables.map((t) => [
      t,
      (sqlite.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[])
        .map((c) => `${c.name}:${c.type}:${c.notnull}:${String(c.dflt_value)}:${c.pk}`)
        .sort(),
    ]),
  );
  const indexes = (sqlite.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name`).all() as {
    name: string;
    tbl_name: string;
    sql: string;
  }[]).map((i) => `${i.tbl_name}.${i.name}:${i.sql.replace(/\s+/g, " ")}`);
  return { tables, columns, indexes };
}

describe("makeTestDb", () => {
  it("creates every table of the schema and installs every guard trigger", () => {
    const db = makeTestDb();
    const { tables } = shape(db.$client);
    expect(tables).toHaveLength(27);
    expect(tables).toContain("activity_events");
    expect(listInstalledGuards(db.$client).sort()).toEqual(GUARDS.map((g) => g.name).sort());
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("returns isolated databases", () => {
    const a = makeTestDb();
    const b = makeTestDb();
    seedMinimalOrg(a);
    expect(a.select({ n: count() }).from(schema.users).get()?.n).toBe(7);
    expect(b.select({ n: count() }).from(schema.users).get()?.n).toBe(0);
  });

  it("committed drizzle migrations are in sync with src/db/schema.ts (run `npx drizzle-kit generate` if this fails)", async () => {
    const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
    const empty = await generateSQLiteDrizzleJson({});
    const current = await generateSQLiteDrizzleJson(schema as unknown as Record<string, unknown>);
    const statements = await generateSQLiteMigration(empty, current);
    const fromSchema = new Database(":memory:");
    for (const s of statements) fromSchema.exec(s);
    const fromMigrations = new Database(":memory:");
    for (const s of schemaStatements()) fromMigrations.exec(s);
    expect(shape(fromSchema).tables).toHaveLength(27);
    expect(shape(fromMigrations)).toEqual(shape(fromSchema));
  }, 30_000);
});

describe("seedMinimalOrg", () => {
  let db: TestDb;
  beforeEach(() => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    db = makeTestDb();
  });
  afterEach(() => fakeClock.reset());

  it("creates the org, settings, 7 users, default workflow, job types, client and project with known ids", () => {
    const ids = seedMinimalOrg(db);
    expect(ids.organisationId).toBe("studio-org");
    expect(ids.users.owner).toBe("studio-owner");
    expect(ids.emails.owner).toBe("owner@studio.test");
    expect(ids.emails.manager).toBe("manager1@studio.test");
    expect(ids.emails.editor1).toBe("editor01@studio.test");

    const users = db.select().from(schema.users).all();
    expect(users).toHaveLength(7);
    expect(users.filter((u) => !u.isActive).map((u) => u.id)).toEqual([ids.users.inactiveEditor]);
    expect(db.select().from(schema.organisationSettings).get()?.timezone).toBe("Australia/Sydney");

    const statuses = db.select().from(schema.workflowStatuses).all();
    expect(statuses).toHaveLength(DEFAULT_WORKFLOW_STATUSES.length);
    expect(statuses.filter((s) => s.isInitial).map((s) => s.key)).toEqual(["new"]);
    const activeCount = DEFAULT_WORKFLOW_STATUSES.filter((s) => STATUS_CATEGORY_META[s.category].open).length;
    const transitions = db.select().from(schema.workflowTransitions).all();
    expect(transitions).toHaveLength(DEFAULT_WORKFLOW_TRANSITIONS.length + activeCount);
    expect(ids.transitions["in_progress->cancelled"]).toBeDefined();
    expect(ids.transitions["completed->cancelled"]).toBeUndefined();
    expect(Object.keys(ids.jobTypes)).toHaveLength(DEFAULT_JOB_TYPES.length);
    expect(db.select().from(schema.projects).get()?.clientId).toBe(ids.clientId);
  });

  it("can seed a second organisation alongside (cross-org tests)", () => {
    const a = seedMinimalOrg(db);
    const b = seedMinimalOrg(db, { slug: "other" });
    expect(b.emails.owner).toBe("owner@other.test");
    expect(a.organisationId).not.toBe(b.organisationId);
    expect(db.select({ n: count() }).from(schema.organisations).get()?.n).toBe(2);
  });

  it("stores a bcrypt hash that verifies TEST_PASSWORD", async () => {
    const ids = seedMinimalOrg(db);
    const owner = db.select().from(schema.users).where(eq(schema.users.id, ids.users.owner)).get();
    expect(owner?.passwordHash).toBe(testPasswordHash());
    expect(await verifyPassword(ids.password, owner?.passwordHash ?? "")).toBe(true);
  });
});

describe("insertJobFixture", () => {
  let db: TestDb;
  beforeEach(() => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    db = makeTestDb();
  });
  afterEach(() => fakeClock.reset());

  it("inserts a job in every default status that satisfies the triggers and db:verify (zero drift)", () => {
    const ids = seedMinimalOrg(db);
    for (const s of DEFAULT_WORKFLOW_STATUSES) {
      fakeClock.advanceMinutes(5);
      const { job } = insertJobFixture(db, ids, { statusKey: s.key, dueDate: "2026-10-12T12:59:59.999Z" });
      expect(job.statusCategory).toBe(s.category);
    }
    const report = verifyDerived(db.$client);
    expect(report.jobsChecked).toBe(DEFAULT_WORKFLOW_STATUSES.length);
    expect(report.drift).toEqual([]);
    expect(report.structural).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("allocates gap-free job numbers and writes the creation ledger + event", () => {
    const ids = seedMinimalOrg(db);
    const first = insertJobFixture(db, ids);
    const second = insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 });
    expect(first.job.jobNumber).toBe("PJ-0001");
    expect(second.job.jobNumber).toBe("PJ-0002");
    expect(second.job.editorId).toBe(ids.users.editor2);
    expect(second.assignmentIds.editor).not.toBeNull();
    expect(first.job.editorId).toBeNull();

    const rows = db.select().from(schema.jobStatusTransitions).where(eq(schema.jobStatusTransitions.jobId, second.job.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 1, kind: "creation", exitedAt: null, activityEventId: second.eventId });
    const event = db.select().from(schema.activityEvents).where(eq(schema.activityEvents.id, second.eventId)).get();
    expect(event).toMatchObject({ eventType: "job.created", jobId: second.job.id, actorUserId: ids.users.photographer1 });
    expect(event?.summary).toBe(`created job PJ-0002 “${second.job.name}”`);
  });

  it("contextFor builds a usable context and teams are opt-in", () => {
    const ids = seedMinimalOrg(db);
    expect(contextFor(db, ids.users.editor1).teamUserIds.size).toBe(0);
    addTeamFixture(db, ids, { name: "Crew", memberIds: [ids.users.editor1, ids.users.photographer1] });
    const ctx = contextFor(db, ids.users.editor1);
    expect([...ctx.teamUserIds]).toEqual([ids.users.photographer1]);
    expect(ctx.now()).toBe("2026-10-08T00:00:00.000Z");
    expect(() => contextFor(db, ids.users.inactiveEditor)).toThrow(/inactive/);
  });
});
