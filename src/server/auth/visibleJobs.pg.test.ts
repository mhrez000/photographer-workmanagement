/** visibleJobsWhere() is valid Postgres and selects the §3.1 scopes on a real database. */
import { and, asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobs } from "@/db/schema";
import { addTeamFixture, contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { visibleJobsWhere } from "./permissions";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { editorsSeeTeamJobs: true, photographersSeeTeamJobs: true } });
});
afterEach(() => fakeClock.reset());

async function visible(ctx: AuthContext): Promise<string[]> {
  const rows = await db.select({ name: jobs.name }).from(jobs).where(and(visibleJobsWhere(ctx))).orderBy(asc(jobs.name));
  return rows.map((r) => r.name);
}

describe("visibleJobsWhere on Postgres", () => {
  it("runs for every role and applies own / assigned / past / team scopes", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, ids, { name: "A ph1-e1", statusKey: "in_progress" });
    await insertJobFixture(db, ids, { name: "B ph2-e2", statusKey: "in_progress", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2, editorId: ids.users.editor2 });
    await insertJobFixture(db, ids, { name: "C ph2-none", statusKey: "new", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    await insertJobFixture(db, other, { name: "Z foreign", statusKey: "new" });

    expect(await visible(await contextFor(db, ids.users.manager))).toEqual(["A ph1-e1", "B ph2-e2", "C ph2-none"]);
    expect(await visible(await contextFor(db, ids.users.photographer1))).toEqual(["A ph1-e1"]);
    expect(await visible(await contextFor(db, ids.users.editor1))).toEqual(["A ph1-e1"]);

    await addTeamFixture(db, ids, { name: "Crew", memberIds: [ids.users.editor1, ids.users.editor2] });
    expect(await visible(await contextFor(db, ids.users.editor1))).toEqual(["A ph1-e1", "B ph2-e2"]);
    const inactive = { ...(await contextFor(db, ids.users.manager)), isActive: false };
    expect(await visible(inactive)).toEqual([]);
  });
});
