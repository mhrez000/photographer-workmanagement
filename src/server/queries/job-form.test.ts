import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organisationSettings, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError } from "@/server/errors";
import { getJobFormDefaults } from "./job-form";

const NOW = "2026-10-08T00:00:00.000Z";
let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
});

afterEach(() => fakeClock.reset());

async function setDefaultPhotographer(userId: string | null): Promise<void> {
  await db.update(organisationSettings).set({ defaultPhotographerUserId: userId }).where(eq(organisationSettings.organisationId, ids.organisationId));
}

describe("getJobFormDefaults (docs/ROLES.md §4.3)", () => {
  it("falls back to the primary owner when no default photographer is set", async () => {
    const d = await getJobFormDefaults(db, await contextFor(db, ids.users.editor1));
    expect(d).toEqual({ defaultPhotographerId: ids.users.owner, primaryOwnerId: ids.users.owner });
  });

  it("uses the configured default photographer while they are an active photographer", async () => {
    await setDefaultPhotographer(ids.users.photographer2);
    const d = await getJobFormDefaults(db, await contextFor(db, ids.users.editor1));
    expect(d.defaultPhotographerId).toBe(ids.users.photographer2);
  });

  it("falls back to the primary owner when the configured photographer is deactivated", async () => {
    await setDefaultPhotographer(ids.users.photographer2);
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.photographer2));
    const d = await getJobFormDefaults(db, await contextFor(db, ids.users.editor1));
    expect(d.defaultPhotographerId).toBe(ids.users.owner);
  });

  it("is available to everyone who can create jobs and refused to an editor without the switch", async () => {
    for (const key of ["owner", "coAdmin", "lead", "photographer1", "editor2"] as const) {
      await expect(getJobFormDefaults(db, await contextFor(db, ids.users[key]))).resolves.toMatchObject({ primaryOwnerId: ids.users.owner });
    }
    await setUserFlags(db, ids.users.editor1, { canCreateJobs: false });
    await expect(getJobFormDefaults(db, await contextFor(db, ids.users.editor1))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses client users", async () => {
    await expect(getJobFormDefaults(db, await contextFor(db, ids.users.client))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
