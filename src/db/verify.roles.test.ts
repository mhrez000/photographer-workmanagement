/** db:verify roles-v2 invariants (docs/ROLES.md §1.4) detect tampering. */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "./test-db";
import { verifyDerived } from "./verify";

let db: TestDb;
let ids: SeedIds;
let other: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  other = await seedMinimalOrg(db, { slug: "other" });
});
afterEach(() => fakeClock.reset());

const checks = async () => (await verifyDerived(db)).structural.map((s) => s.check).sort();

/** Tamper with the guards off (as a careless bulk load would). */
async function raw(statement: string): Promise<void> {
  await db.$client.exec(`SET session_replication_role = replica; ${statement}; SET session_replication_role = origin;`);
}

describe("roles v2 invariants", () => {
  it("a fixture organisation is clean", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect(await checks()).toEqual([]);
  });

  it("detects orgs without an active admin and an invalid primary owner", async () => {
    await raw(`UPDATE users SET is_admin = false WHERE id IN ('${ids.users.owner}', '${ids.users.coAdmin}')`);
    expect(await checks()).toEqual(["org_has_active_admin", "org_primary_owner_valid"]);
  });

  it("detects a default photographer who is not a photographer of the organisation", async () => {
    await db.execute(sql.raw(`UPDATE organisation_settings SET default_photographer_user_id = '${ids.users.editor1}' WHERE organisation_id = '${ids.organisationId}'`));
    expect(await checks()).toEqual(["org_default_photographer_valid"]);
  });

  it("detects a client user linked to another organisation's client", async () => {
    await raw(`UPDATE users SET client_id = '${other.clientId}' WHERE id = '${ids.users.client}'`);
    expect(await checks()).toEqual(["client_user_client_in_org"]);
  });

  it("detects legacy edge roles and legacy user roles", async () => {
    await db.execute(sql.raw(`UPDATE workflow_transitions SET allowed_roles = '["owner", "manager"]'::jsonb WHERE id = '${ids.transitions["new->ready"]}'`));
    await db.execute(sql.raw("ALTER TABLE users DROP CONSTRAINT users_role_ck"));
    await raw(`UPDATE users SET role = 'manager' WHERE id = '${ids.users.lead}'`);
    expect(await checks()).toEqual(["no_legacy_roles", "transition_roles_valid"]);
  });

  it("detects a created_by_role that disagrees with the job.created event", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    await db.execute(sql.raw(`UPDATE jobs SET created_by_role = 'editor' WHERE id = '${job.id}'`));
    expect(await checks()).toEqual(["job_created_by_role_matches"]);
  });
});
