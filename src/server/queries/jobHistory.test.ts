/**
 * Job History (milestones linked to stages) + same-millisecond event order.
 * Also renders the History tab to check the start / decline wording.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { HistoryTab } from "@/components/job-detail/history-tab";
import { recordEvent } from "@/server/audit";
import { withTx } from "@/server/services/_shared";
import { pauseJob, resumeJob } from "@/server/services/jobs";
import { acceptJob, declineJob, startJob, submitJob } from "@/server/services/workflow";
import { jobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { jobEvents, listActivity } from "./activity";
import { getJobHistory } from "./jobHistory";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const v = (id: string) => (db.select({ v: jobs.version }).from(jobs).where(eq(jobs.id, id)).get()?.v ?? 0);

function acceptStartSubmit(): string {
  const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
  run((tx) => acceptJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: v(job.id) }));
  fakeClock.advanceHours(1);
  run((tx) => startJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: v(job.id) }));
  fakeClock.advanceHours(1);
  run((tx) => submitJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: v(job.id) }));
  return job.id;
}

const historyHtml = (key: FixtureUserKey, jobId: string) => {
  const entries = getJobHistory(db, ctxOf(key), jobId);
  const current = entries.filter((e) => e.kind === "stage").at(-1)?.stage?.toStatus;
  if (!current) throw new Error("no stages");
  return renderToStaticMarkup(createElement(HistoryTab, { entries, timeZone: "Australia/Sydney", current })).replace(/<[^>]+>/g, "");
};

describe("getJobHistory", () => {
  it("an accept → start → submit job includes job.accepted, job.work_started and job.submitted (for the editor too)", () => {
    const jobId = acceptStartSubmit();
    for (const key of ["manager", "editor1", "photographer1"] as const) {
      const types = getJobHistory(db, ctxOf(key), jobId)
        .filter((e) => e.kind === "event")
        .map((e) => e.event?.eventType);
      expect(types).toEqual(expect.arrayContaining(["job.accepted", "job.work_started", "job.submitted"]));
      // management-only events never reach the History tab of a non-manager
      if (key !== "manager") expect(getJobHistory(db, ctxOf(key), jobId).every((e) => e.kind === "stage" || e.event?.visibility === "all")).toBe(true);
    }
  });

  it("History tab: the first start after Accepted reads 'started editing', not 'resumed'", () => {
    const jobId = acceptStartSubmit();
    const text = historyHtml("manager", jobId);
    expect(text).toContain("started editing");
    expect(text).not.toContain("resumed editing");
  });

  it("History tab: a pause/resume shows both, and a decline reads 'declined the job' (not 'unassigned the editor')", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    run((tx) => pauseJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: v(job.id) }));
    run((tx) => resumeJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: v(job.id) }));
    const paused = historyHtml("manager", job.id);
    expect(paused).toMatch(/paused/i);
    expect(paused).toMatch(/resumed/i);

    const d = insertJobFixture(db, ids, { statusKey: "assigned" }).job;
    run((tx) => declineJob(tx, ctxOf("editor1"), { jobId: d.id, expectedVersion: v(d.id), reason: "Too busy" }));
    const declined = historyHtml("manager", d.id);
    expect(declined).toContain("declined the job");
    expect(declined).not.toContain("unassigned the editor");
    expect(declined.match(/declined the job/g)).toHaveLength(1);
  });
});

describe("same-millisecond events keep their insertion order", () => {
  it("jobEvents, getJobHistory and the paginated feed follow insertion order, not the random id", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    fakeClock.advanceHours(1);
    const ctx = ctxOf("manager");
    const written = run((tx) =>
      Array.from({ length: 12 }, (_, i) =>
        recordEvent(tx, ctx, {
          entityType: "job",
          entityId: job.id,
          jobId: job.id,
          eventType: "job.due_date_changed",
          action: "updated",
          previousValue: { value: null },
          newValue: { value: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` },
        }),
      ),
    );
    const sameMs = jobEvents(db, ctx, job.id, ["job.due_date_changed"]).map((e) => e.id);
    expect(sameMs).toEqual(written);
    const history = getJobHistory(db, ctx, job.id).filter((e) => e.event?.eventType === "job.due_date_changed").map((e) => e.event?.id);
    expect(history).toEqual(written);

    // newest first, stable across pages
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = listActivity(db, ctx, { jobId: job.id, eventType: ["job.due_date_changed"], limit: 5, cursor: cursor ?? undefined });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...written].reverse());
  });
});
