/**
 * Audit-log immutability, three layers (ARCHITECTURE.md §0.2):
 *   (a)/(b) no source code path updates activity_events or deletes ledger rows
 *   (c) Postgres triggers (drizzle/0001_guards.sql) reject it at the DB level
 * plus: a mutation that throws mid-transaction leaves no event behind, and
 * recordEvent's own contract (summary, metadata, visibility, redaction, activity bump).
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, jobs, jobStatusTransitions } from "@/db/schema";
import { contextFor, dbRejection, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { withTx } from "@/server/services/_shared";
import { recordEvent, recordEvents, redact } from "./audit";

/* ------------------------------------------------------------------ */
/*  (a) source grep                                                    */
/* ------------------------------------------------------------------ */

const LEDGER_VARS = [
  "activityEvents",
  "jobStatusTransitions",
  "jobAssignments",
  "jobRevisions",
  "jobLinks",
  "jobComments",
  "workSessions",
  "automationRuns",
  "notifications",
  "teamMemberships",
  "jobs",
  "users",
];
const LEDGER_TABLES = [
  "activity_events",
  "job_status_transitions",
  "job_assignments",
  "job_revisions",
  "job_links",
  "job_comments",
  "work_sessions",
  "automation_runs",
  "notifications",
  "team_memberships",
  "jobs",
  "users",
];

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "drizzle update(activityEvents)", pattern: /\bupdate\(\s*(?:schema\.|s\.)?activityEvents\b/ },
  { name: "drizzle delete(<ledger>)", pattern: new RegExp(String.raw`\.delete\(\s*(?:schema\.|s\.)?(?:${LEDGER_VARS.join("|")})\b`) },
  { name: "raw UPDATE activity_events", pattern: /\bUPDATE\s+[`"']?activity_events\b/i },
  { name: "raw DELETE FROM <ledger>", pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+[\`"']?(?:${LEDGER_TABLES.join("|")})\b`, "i") },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("source code never mutates the audit ledger", () => {
  it("the patterns catch the forbidden shapes (self-test)", () => {
    const samples = [
      "tx.update(activityEvents).set({ summary: 'x' })",
      "db.update(schema.activityEvents)",
      "tx.delete(jobStatusTransitions).where(x)",
      "db.delete( notifications )",
      "sqlite.exec('UPDATE activity_events SET summary = 1')",
      "sqlite.prepare(`DELETE FROM job_links WHERE id = ?`)",
    ];
    for (const sample of samples) expect(FORBIDDEN.some((f) => f.pattern.test(sample)), sample).toBe(true);
    for (const ok of ["tx.update(jobs).set({ lastActivityAt })", "tx.update(jobStatusTransitions).set({ exitedAt })", "BEFORE UPDATE ON activity_events", "BEFORE DELETE ON jobs"]) {
      expect(FORBIDDEN.some((f) => f.pattern.test(ok)), ok).toBe(false);
    }
  });

  it("no file under src/ contains a forbidden ledger mutation", () => {
    const root = path.resolve(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, "utf8");
      for (const { name, pattern } of FORBIDDEN) {
        const m = text.match(pattern);
        if (m) offenders.push(`${path.relative(process.cwd(), file)}: ${name} → "${m[0]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  (c) triggers + transactional integrity                             */
/* ------------------------------------------------------------------ */

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

describe("DB triggers", () => {
  it("reject UPDATE and DELETE on activity_events (raw SQL and Drizzle)", async () => {
    const { eventId } = await insertJobFixture(db, ids);
    expect(await dbRejection(db.$client.query(`UPDATE activity_events SET summary = 'x' WHERE id = $1`, [eventId]))).toMatch(/append-only/);
    expect(await dbRejection(db.$client.query(`DELETE FROM activity_events WHERE id = $1`, [eventId]))).toMatch(/append-only/);
    expect(await dbRejection(db.$client.query(`DELETE FROM activity_events`))).toMatch(/append-only/);
    // Postgres-only hole closed too: TRUNCATE bypasses row triggers, so it has its own guard.
    expect(await dbRejection(db.$client.query(`TRUNCATE activity_events CASCADE`))).toMatch(/append-only/);
    expect(await dbRejection(db.update(activityEvents).set({ visibility: "all" }).where(eq(activityEvents.id, eventId)))).toMatch(/append-only/);
    expect((await db.select().from(activityEvents).where(eq(activityEvents.id, eventId)))[0]?.summary).toMatch(/^created job/);
  });

  it("reject DELETE on every ledger and on jobs/users", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const statements: [string, string][] = [
      ["job_status_transitions", `DELETE FROM job_status_transitions WHERE job_id = '${job.id}'`],
      ["job_assignments", `DELETE FROM job_assignments WHERE job_id = '${job.id}'`],
      ["jobs", `DELETE FROM jobs WHERE id = '${job.id}'`],
      ["users", `DELETE FROM users WHERE id = '${ids.users.editor2}'`],
    ];
    for (const [table, statement] of statements) {
      expect(await dbRejection(db.$client.query(statement)), table).toMatch(/append-only|cannot be deleted/);
    }
  });

  it("accept a fill-once close exactly once", async () => {
    const { transitionId } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const close = (at: string) =>
      db.update(jobStatusTransitions).set({ exitedAt: at, durationSeconds: 60 }).where(eq(jobStatusTransitions.id, transitionId));
    await expect(close("2026-10-08T00:01:00.000Z")).resolves.not.toThrow();
    expect(await dbRejection(close("2026-10-08T00:02:00.000Z"))).toMatch(/fill-once/);
  });

  it("reject a status change without its open transition row", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    expect(
      await dbRejection(db.update(jobs).set({ statusId: ids.statuses.in_progress, statusCategory: "in_progress" }).where(eq(jobs.id, job.id))),
    ).toMatch(/transitionJobStatus/);
  });
});

describe("transactional integrity", () => {
  it("a service that throws mid-transaction leaves no event and no activity bump", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const before = (await db.select().from(activityEvents)).length;
    const ctx = await contextFor(db, ids.users.manager);
    fakeClock.advanceHours(1);
    await expect(
      withTx(
        async (tx) => {
          await tx.update(jobs).set({ priority: "urgent" }).where(eq(jobs.id, job.id));
          await recordEvent(tx, ctx, {
            entityType: "job",
            entityId: job.id,
            jobId: job.id,
            eventType: "job.priority_changed",
            action: "updated",
            previousValue: { priority: "normal" },
            newValue: { priority: "urgent" },
          });
          throw new Error("boom after the event");
        },
        { db },
      ),
    ).rejects.toThrow("boom after the event");
    expect(await db.select().from(activityEvents)).toHaveLength(before);
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after?.priority).toBe("normal");
    expect(after?.lastActivityAt).toBe(job.lastActivityAt);
  });

  it("an unknown event type aborts the whole mutation", async () => {
    const ctx = await contextFor(db, ids.users.manager);
    await expect(
      withTx(
        (tx) =>
          recordEvent(tx, ctx, {
            entityType: "job",
            entityId: "x",
            // @ts-expect-error — deliberately invalid
            eventType: "job.teleported",
            action: "updated",
          }),
        { db },
      ),
    ).rejects.toThrow(/unknown event type/);
  });
});

/* ------------------------------------------------------------------ */
/*  recordEvent contract                                               */
/* ------------------------------------------------------------------ */

describe("recordEvent", () => {
  it("writes actor, frozen actor-less summary and metadata { requestId, cause, ...extras }", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const ctx = await contextFor(db, ids.users.editor1, { requestId: "req-42" });
    fakeClock.advanceMinutes(30);
    const id = await withTx(
      (tx) =>
        recordEvent(tx, ctx, {
          entityType: "job",
          entityId: job.id,
          jobId: job.id,
          eventType: "job.status_changed",
          action: "transitioned",
          previousValue: { statusId: ids.statuses.assigned, statusName: "Assigned", category: "assigned" },
          newValue: { statusId: ids.statuses.in_progress, statusName: "In Progress", category: "in_progress" },
          metadata: { transitionId: "t-1", sequence: 2 },
        }),
      { db },
    );
    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.id, id));
    expect(event).toMatchObject({
      organisationId: ids.organisationId,
      actorUserId: ids.users.editor1,
      jobId: job.id,
      summary: "changed status from Assigned to In Progress",
      visibility: "all",
      createdAt: "2026-10-08T00:30:00.000Z",
      metadata: { requestId: "req-42", cause: "user", transitionId: "t-1", sequence: 2 },
    });
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]?.lastActivityAt).toBe("2026-10-08T00:30:00.000Z");
  });

  it("bumps last_activity_at monotonically (a backdated event never rewinds it) and never bumps version", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = await contextFor(db, ids.users.manager);
    const write = () =>
      withTx(
        (tx) => recordEvent(tx, ctx, { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.paused", action: "paused" }),
        { db },
      );
    fakeClock.advanceHours(2);
    await write();
    fakeClock.set("2026-10-07T00:00:00.000Z");
    await write();
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.lastActivityAt).toBe("2026-10-08T02:00:00.000Z");
    expect(row?.version).toBe(job.version);
  });

  it("forces management visibility for management prefixes and internal notes, never downgrades", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = await contextFor(db, ids.users.manager);
    const [userEvt, internalNote, editorNote, explicit] = await withTx(
      (tx) =>
        recordEvents(tx, ctx, [
          { entityType: "user", entityId: ids.users.editor2, eventType: "user.capacity_changed", action: "updated", visibility: "all" },
          { entityType: "note", entityId: "n1", jobId: job.id, eventType: "note.added", action: "created", newValue: { kind: "internal", body: "pay rate" } },
          { entityType: "note", entityId: "n2", jobId: job.id, eventType: "note.added", action: "created", newValue: { kind: "editor", body: "hi" } },
          { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.priority_changed", action: "updated", visibility: "management" },
        ]),
      { db },
    );
    const vis = async (id: string) => (await db.select().from(activityEvents).where(eq(activityEvents.id, id)))[0]?.visibility;
    expect(await vis(userEvt)).toBe("management");
    expect(await vis(internalNote)).toBe("management");
    expect(await vis(editorNote)).toBe("all");
    expect(await vis(explicit)).toBe("management");
  });

  it("redacts password hashes, secrets and tokens from snapshots and metadata", async () => {
    const ctx = await contextFor(db, ids.users.owner);
    const id = await withTx(
      (tx) =>
        recordEvent(tx, ctx, {
          entityType: "user",
          entityId: ids.users.editor1,
          eventType: "user.updated",
          action: "updated",
          previousValue: { name: "Eve", passwordHash: "$2a$12$abc", nested: { apiToken: "t", ok: 1 } },
          newValue: { name: "Eve E", password: "plain", resetSecret: "s" },
          metadata: { sessionToken: "x", targetUserId: ids.users.editor1 },
        }),
      { db },
    );
    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.id, id));
    expect(event?.previousValue).toEqual({ name: "Eve", nested: { ok: 1 } });
    expect(event?.newValue).toEqual({ name: "Eve E" });
    expect(event?.metadata).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(event)).not.toMatch(/\$2a\$|plain/);
  });

  it("redact() normalises values to JSON", async () => {
    expect(redact({ a: undefined, b: new Date("2026-01-01T00:00:00.000Z"), c: [1, undefined, NaN], d: () => 1 })).toEqual({
      b: "2026-01-01T00:00:00.000Z",
      c: [1, null, null],
    });
  });

  it("system contexts write actor null with cause sweep/seed", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T12:59:59.999Z" });
    const ownerCtx = await contextFor(db, ids.users.owner);
    const id = await withTx(
      (tx) =>
        recordEvent(tx, { ...ownerCtx, userId: null, isSystem: true }, {
          entityType: "job",
          entityId: job.id,
          jobId: job.id,
          eventType: "job.became_overdue",
          action: "flagged",
          newValue: { dueDate: job.dueDate, overdueSince: job.dueDate },
        }),
      { db },
    );
    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.id, id));
    expect(event?.actorUserId).toBeNull();
    expect(event?.metadata).toMatchObject({ cause: "sweep" });
    expect(event?.summary).toBe("flagged the job as overdue");
  });
});

/* ------------------------------------------------------------------ */
/*  The audit module's surface: one insert path, nothing that rewrites */
/* ------------------------------------------------------------------ */

describe("audit module exports", () => {
  it("exposes only recordEvent / recordEvents / redact / isManagementEvent (no update or delete helper can sneak in)", async () => {
    const mod = await import("./audit");
    const allowed = ["recordEvent", "recordEvents", "redact", "isManagementEvent"];
    expect(Object.keys(mod).filter((k) => !allowed.includes(k))).toEqual([]);
  });
});
