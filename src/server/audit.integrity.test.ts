/**
 * Audit-log immutability, three layers (ARCHITECTURE.md §0.2):
 *   (a)/(b) no source code path updates activity_events or deletes ledger rows
 *   (c) SQLite triggers reject it at the DB level
 * plus: a mutation that throws mid-transaction leaves no event behind, and
 * recordEvent's own contract (summary, metadata, visibility, redaction, activity bump).
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, jobs, jobStatusTransitions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
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

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

describe("DB triggers", () => {
  it("reject UPDATE and DELETE on activity_events (raw SQL and Drizzle)", () => {
    const { eventId } = insertJobFixture(db, ids);
    expect(() => db.$client.prepare(`UPDATE activity_events SET summary = 'x' WHERE id = ?`).run(eventId)).toThrow(/append-only/);
    expect(() => db.$client.prepare(`DELETE FROM activity_events WHERE id = ?`).run(eventId)).toThrow(/append-only/);
    expect(() => db.$client.prepare(`DELETE FROM activity_events`).run()).toThrow(/append-only/);
    expect(() => db.update(activityEvents).set({ visibility: "all" }).where(eq(activityEvents.id, eventId)).run()).toThrow(/append-only/);
    expect(db.select().from(activityEvents).where(eq(activityEvents.id, eventId)).get()?.summary).toMatch(/^created job/);
  });

  it("reject DELETE on every ledger and on jobs/users", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const statements: [string, string][] = [
      ["job_status_transitions", `DELETE FROM job_status_transitions WHERE job_id = '${job.id}'`],
      ["job_assignments", `DELETE FROM job_assignments WHERE job_id = '${job.id}'`],
      ["jobs", `DELETE FROM jobs WHERE id = '${job.id}'`],
      ["users", `DELETE FROM users WHERE id = '${ids.users.editor2}'`],
    ];
    for (const [table, statement] of statements) {
      expect(() => db.$client.prepare(statement).run(), table).toThrow();
    }
  });

  it("accept a fill-once close exactly once", () => {
    const { transitionId } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const close = (at: string) =>
      db.update(jobStatusTransitions).set({ exitedAt: at, durationSeconds: 60 }).where(eq(jobStatusTransitions.id, transitionId)).run();
    expect(() => close("2026-10-08T00:01:00.000Z")).not.toThrow();
    expect(() => close("2026-10-08T00:02:00.000Z")).toThrow(/fill-once/);
  });

  it("reject a status change without its open transition row", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    expect(() =>
      db.update(jobs).set({ statusId: ids.statuses.in_progress, statusCategory: "in_progress" }).where(eq(jobs.id, job.id)).run(),
    ).toThrow(/transitionJobStatus/);
  });
});

describe("transactional integrity", () => {
  it("a service that throws mid-transaction leaves no event and no activity bump", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const before = db.select().from(activityEvents).all().length;
    const ctx = contextFor(db, ids.users.manager);
    fakeClock.advanceHours(1);
    expect(() =>
      withTx(
        (tx) => {
          tx.update(jobs).set({ priority: "urgent" }).where(eq(jobs.id, job.id)).run();
          recordEvent(tx, ctx, {
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
    ).toThrow("boom after the event");
    expect(db.select().from(activityEvents).all()).toHaveLength(before);
    const after = db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    expect(after?.priority).toBe("normal");
    expect(after?.lastActivityAt).toBe(job.lastActivityAt);
  });

  it("an unknown event type aborts the whole mutation", () => {
    const ctx = contextFor(db, ids.users.manager);
    expect(() =>
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
    ).toThrow(/unknown event type/);
  });
});

/* ------------------------------------------------------------------ */
/*  recordEvent contract                                               */
/* ------------------------------------------------------------------ */

describe("recordEvent", () => {
  it("writes actor, frozen actor-less summary and metadata { requestId, cause, ...extras }", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    const ctx = contextFor(db, ids.users.editor1, { requestId: "req-42" });
    fakeClock.advanceMinutes(30);
    const id = withTx(
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
    const event = db.select().from(activityEvents).where(eq(activityEvents.id, id)).get();
    expect(event).toMatchObject({
      organisationId: ids.organisationId,
      actorUserId: ids.users.editor1,
      jobId: job.id,
      summary: "changed status from Assigned to In Progress",
      visibility: "all",
      createdAt: "2026-10-08T00:30:00.000Z",
      metadata: { requestId: "req-42", cause: "user", transitionId: "t-1", sequence: 2 },
    });
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.lastActivityAt).toBe("2026-10-08T00:30:00.000Z");
  });

  it("bumps last_activity_at monotonically (a backdated event never rewinds it) and never bumps version", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = contextFor(db, ids.users.manager);
    const write = () =>
      withTx(
        (tx) => recordEvent(tx, ctx, { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.paused", action: "paused" }),
        { db },
      );
    fakeClock.advanceHours(2);
    write();
    fakeClock.set("2026-10-07T00:00:00.000Z");
    write();
    const row = db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    expect(row?.lastActivityAt).toBe("2026-10-08T02:00:00.000Z");
    expect(row?.version).toBe(job.version);
  });

  it("forces management visibility for management prefixes and internal notes, never downgrades", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const ctx = contextFor(db, ids.users.manager);
    const [userEvt, internalNote, editorNote, explicit] = withTx(
      (tx) =>
        recordEvents(tx, ctx, [
          { entityType: "user", entityId: ids.users.editor2, eventType: "user.capacity_changed", action: "updated", visibility: "all" },
          { entityType: "note", entityId: "n1", jobId: job.id, eventType: "note.added", action: "created", newValue: { kind: "internal", body: "pay rate" } },
          { entityType: "note", entityId: "n2", jobId: job.id, eventType: "note.added", action: "created", newValue: { kind: "editor", body: "hi" } },
          { entityType: "job", entityId: job.id, jobId: job.id, eventType: "job.priority_changed", action: "updated", visibility: "management" },
        ]),
      { db },
    );
    const vis = (id: string) => db.select().from(activityEvents).where(eq(activityEvents.id, id)).get()?.visibility;
    expect(vis(userEvt)).toBe("management");
    expect(vis(internalNote)).toBe("management");
    expect(vis(editorNote)).toBe("all");
    expect(vis(explicit)).toBe("management");
  });

  it("redacts password hashes, secrets and tokens from snapshots and metadata", () => {
    const ctx = contextFor(db, ids.users.owner);
    const id = withTx(
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
    const event = db.select().from(activityEvents).where(eq(activityEvents.id, id)).get();
    expect(event?.previousValue).toEqual({ name: "Eve", nested: { ok: 1 } });
    expect(event?.newValue).toEqual({ name: "Eve E" });
    expect(event?.metadata).not.toHaveProperty("sessionToken");
    expect(JSON.stringify(event)).not.toMatch(/\$2a\$|plain/);
  });

  it("redact() normalises values to JSON", () => {
    expect(redact({ a: undefined, b: new Date("2026-01-01T00:00:00.000Z"), c: [1, undefined, NaN], d: () => 1 })).toEqual({
      b: "2026-01-01T00:00:00.000Z",
      c: [1, null, null],
    });
  });

  it("system contexts write actor null with cause sweep/seed", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", dueDate: "2026-10-07T12:59:59.999Z" });
    const id = withTx(
      (tx) =>
        recordEvent(tx, { ...contextFor(db, ids.users.owner), userId: null, isSystem: true }, {
          entityType: "job",
          entityId: job.id,
          jobId: job.id,
          eventType: "job.became_overdue",
          action: "flagged",
          newValue: { dueDate: job.dueDate, overdueSince: job.dueDate },
        }),
      { db },
    );
    const event = db.select().from(activityEvents).where(eq(activityEvents.id, id)).get();
    expect(event?.actorUserId).toBeNull();
    expect(event?.metadata).toMatchObject({ cause: "sweep" });
    expect(event?.summary).toBe("flagged the job as overdue");
  });
});
