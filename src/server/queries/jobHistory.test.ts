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

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(async () => fakeClock.reset());

const ctxOf = async (key: FixtureUserKey) => await contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> => withTx(fn, { db });
const v = async (id: string) => (await db.select({ v: jobs.version }).from(jobs).where(eq(jobs.id, id)))[0]?.v ?? 0;

/** Context + expected version, read from the ROOT db before the transaction opens. */
async function prep(key: FixtureUserKey, jobId: string) {
  return { ctx: await ctxOf(key), expectedVersion: await v(jobId) };
}

async function acceptStartSubmit(): Promise<string> {
  const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
  let p = await prep("editor1", job.id);
  await run((tx) => acceptJob(tx, p.ctx, { jobId: job.id, expectedVersion: p.expectedVersion }));
  fakeClock.advanceHours(1);
  p = await prep("editor1", job.id);
  await run((tx) => startJob(tx, p.ctx, { jobId: job.id, expectedVersion: p.expectedVersion }));
  fakeClock.advanceHours(1);
  p = await prep("editor1", job.id);
  await run((tx) => submitJob(tx, p.ctx, { jobId: job.id, expectedVersion: p.expectedVersion }));
  return job.id;
}

const historyHtml = async (key: FixtureUserKey, jobId: string) => {
  const entries = await getJobHistory(db, await ctxOf(key), jobId);
  const current = entries.filter((e) => e.kind === "stage").at(-1)?.stage?.toStatus;
  if (!current) throw new Error("no stages");
  return renderToStaticMarkup(createElement(HistoryTab, { entries, timeZone: "Australia/Sydney", current })).replace(/<[^>]+>/g, "");
};

describe("getJobHistory", () => {
  it("an accept → start → submit job includes job.accepted, job.work_started and job.submitted (for the editor too)", async () => {
    const jobId = await acceptStartSubmit();
    for (const key of ["coAdmin", "editor1", "photographer1"] as const) {
      const types = (await getJobHistory(db, await ctxOf(key), jobId)).filter((e) => e.kind === "event").map((e) => e.event?.eventType);
      expect(types).toEqual(expect.arrayContaining(["job.accepted", "job.work_started", "job.submitted"]));
      // management-only events never reach the History tab of a non-admin
      if (key !== "coAdmin")
        expect((await getJobHistory(db, await ctxOf(key), jobId)).every((e) => e.kind === "stage" || e.event?.visibility === "all")).toBe(true);
    }
  });

  it("History tab: the first start after Accepted reads 'started editing', not 'resumed'", async () => {
    const jobId = await acceptStartSubmit();
    const text = await historyHtml("coAdmin", jobId);
    expect(text).toContain("started editing");
    expect(text).not.toContain("resumed editing");
  });

  it("History tab: a pause/resume shows both, and a decline reads 'handed the job back' (not 'took the job back')", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    let p = await prep("editor1", job.id);
    await run((tx) => pauseJob(tx, p.ctx, { jobId: job.id, expectedVersion: p.expectedVersion }));
    p = await prep("editor1", job.id);
    await run((tx) => resumeJob(tx, p.ctx, { jobId: job.id, expectedVersion: p.expectedVersion }));
    const paused = await historyHtml("coAdmin", job.id);
    expect(paused).toMatch(/paused/i);
    expect(paused).toMatch(/resumed/i);

    const d = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job;
    p = await prep("editor1", d.id);
    await run((tx) => declineJob(tx, p.ctx, { jobId: d.id, expectedVersion: p.expectedVersion, reason: "Too busy" }));
    const declined = await historyHtml("coAdmin", d.id);
    // Plain words (plan §5): "Can't do this one" reads as handing the job back, never as the owner taking it back.
    expect(declined).toContain("handed the job back");
    expect(declined).not.toContain("took the job back");
    expect(declined.match(/handed the job back/g)).toHaveLength(1);
  });
});

describe("same-millisecond events keep their insertion order", () => {
  it("jobEvents, getJobHistory and the paginated feed follow insertion order, not the random id", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    fakeClock.advanceHours(1);
    const ctx = await ctxOf("coAdmin");
    const written = await run(async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        out.push(
          await recordEvent(tx, ctx, {
            entityType: "job",
            entityId: job.id,
            jobId: job.id,
            eventType: "job.due_date_changed",
            action: "updated",
            previousValue: { value: null },
            newValue: { value: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` },
          }),
        );
      }
      return out;
    });
    const sameMs = (await jobEvents(db, ctx, job.id, ["job.due_date_changed"])).map((e) => e.id);
    expect(sameMs).toEqual(written);
    const history = (await getJobHistory(db, ctx, job.id)).filter((e) => e.event?.eventType === "job.due_date_changed").map((e) => e.event?.id);
    expect(history).toEqual(written);

    // newest first, stable across pages
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await listActivity(db, ctx, { jobId: job.id, eventType: ["job.due_date_changed"], limit: 5, cursor: cursor ?? undefined });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...written].reverse());
  });
});
