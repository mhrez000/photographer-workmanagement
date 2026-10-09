import { describe, expect, it } from "vitest";
import { makeTestDb, seedMinimalOrg, insertJobFixture, fakeClock } from "@/db/test-db";
import { activityEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CRON_SECRET_MIN_LENGTH, cronSecret, isAuthorisedCronRequest, sweepAllOrganisations } from "./cron";

const SECRET = "s".repeat(CRON_SECRET_MIN_LENGTH);

describe("cron secret", () => {
  it("is disabled when unset or too short", () => {
    expect(cronSecret({})).toBeNull();
    expect(cronSecret({ CRON_SECRET: "short" })).toBeNull();
    expect(cronSecret({ CRON_SECRET: ` ${SECRET} ` })).toBe(SECRET);
  });

  it("accepts only the exact bearer secret", () => {
    expect(isAuthorisedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorisedCronRequest(`bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorisedCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorisedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorisedCronRequest(null, SECRET)).toBe(false);
    expect(isAuthorisedCronRequest(`Bearer ${SECRET}`, null)).toBe(false);
  });
});

describe("sweepAllOrganisations", () => {
  it("flags overdue jobs in every organisation exactly once", () => {
    const db = makeTestDb();
    fakeClock.set("2026-10-09T00:00:00.000Z");
    try {
      const a = seedMinimalOrg(db, { slug: "alpha", emailDomain: "alpha.test" });
      const b = seedMinimalOrg(db, { slug: "beta", emailDomain: "beta.test" });
      const jobA = insertJobFixture(db, a, { statusKey: "in_progress", editorId: a.users.editor1, dueDate: "2026-10-05T12:59:59.999Z" });
      const jobB = insertJobFixture(db, b, { statusKey: "in_progress", editorId: b.users.editor1, dueDate: "2026-10-05T12:59:59.999Z" });

      const first = sweepAllOrganisations(db);
      expect(first.organisations).toBe(2);
      expect(first.results.flatMap((r) => r.overdueJobIds).sort()).toEqual([jobA.job.id, jobB.job.id].sort());
      expect(first.results.every((r) => r.errors.length === 0)).toBe(true);

      const second = sweepAllOrganisations(db);
      expect(second.results.flatMap((r) => r.overdueJobIds)).toEqual([]);
      const flagged = db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.became_overdue")).all();
      expect(flagged).toHaveLength(2);
    } finally {
      fakeClock.reset();
    }
  });
});
