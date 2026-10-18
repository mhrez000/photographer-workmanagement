/**
 * Roles v2 data migration (drizzle/0002_roles_v2.sql + drizzle/0003_roles_v2_data.sql,
 * docs/ROLES.md §1.3, §12.1). Boots PGlite at migration 0001 (the v1 schema),
 * inserts legacy data with the OLD roles (owner, manager, photographer, editor),
 * applies 0002 + 0003 and asserts the mapping, the audit trail, the edge and
 * automation rewrites, the new CHECKs and triggers, and zero drift.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "./schema";
import { execRows, migrationsFolder, PGLITE_PARSERS } from "./index";
import { isCheckViolation, isGuardViolation, rootErrorMessage } from "./errors";
import { GUARDS, ROW_GUARDS, listInstalledGuards } from "./guard";
import { verifyDerived } from "./verify";

const opened: PGlite[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => (c.closed ? Promise.resolve() : c.close())));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder holding only the first `count` committed migrations (the v1 schema). */
function partialMigrationsFolder(count: number): string {
  const src = migrationsFolder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwm-roles-v1-"));
  tempDirs.push(dir);
  const journal = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const entries = journal.entries.filter((e) => e.idx < count);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  for (const e of entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

async function v1Database() {
  const client = await PGlite.create({ parsers: PGLITE_PARSERS });
  opened.push(client);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: partialMigrationsFolder(2) });
  return { client, db };
}

const T0 = "2026-01-01T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

type Q = { query: (text: string, params?: unknown[]) => Promise<unknown> };

async function insertOrg(c: Q, id: string, settings: { seeAll?: boolean; editorsTeam?: boolean } = {}) {
  await c.query(`INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES ($1, $1, $1, $2, $2)`, [id, T0]);
  await c.query(
    `INSERT INTO organisation_settings (organisation_id, photographers_see_all_jobs, editors_see_team_jobs, updated_at) VALUES ($1, $2, $3, $4)`,
    [id, settings.seeAll ?? false, settings.editorsTeam ?? false, T0],
  );
}

async function insertUser(
  c: Q,
  id: string,
  org: string,
  role: "owner" | "manager" | "photographer" | "editor",
  minute: number,
  opts: { active?: boolean; analytics?: boolean } = {},
) {
  await c.query(
    `INSERT INTO users (id, organisation_id, email, password_hash, name, role, is_active, can_view_analytics, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $1, $4, $5, $6, $7, $7)`,
    [id, org, `${id}@legacy.test`, role, opts.active ?? true, opts.analytics ?? false, at(minute)],
  );
}

const OMP = ["owner", "manager", "photographer"];
const OME = ["owner", "manager", "editor"];
const OM = ["owner", "manager"];
const E = ["editor"];
const OMPE = ["owner", "manager", "photographer", "editor"];

/** Legacy fixture: 3 orgs (healthy / inactive owner with an active manager / nobody can become admin). */
async function insertLegacyData(c: Q) {
  // ---- org A: owner, 2 managers, flagged photographer, editors; org switches on
  await insertOrg(c, "a", { seeAll: true, editorsTeam: true });
  await insertUser(c, "a-owner", "a", "owner", 0);
  await insertUser(c, "a-m1", "a", "manager", 1);
  await insertUser(c, "a-m2", "a", "manager", 2);
  await insertUser(c, "a-p1", "a", "photographer", 3, { analytics: true });
  await insertUser(c, "a-e1", "a", "editor", 4);
  await insertUser(c, "a-e2", "a", "editor", 5);
  await insertUser(c, "a-e3", "a", "editor", 6, { active: false });

  await c.query(`INSERT INTO workflows (id, organisation_id, name, is_default, created_at, updated_at) VALUES ('a-wf', 'a', 'WF', true, $1, $1)`, [T0]);
  const statuses = ["new", "ready", "assigned", "in_progress", "submitted", "approved"] as const;
  for (const [i, key] of statuses.entries()) {
    await c.query(
      `INSERT INTO workflow_statuses (id, organisation_id, workflow_id, key, name, category, sort_order, is_initial, created_at, updated_at)
       VALUES ($1, 'a', 'a-wf', $2, $2, $2, $3, $4, $5, $5)`,
      [`a-st-${key}`, key, i, key === "new", T0],
    );
  }
  const edges: [string, string, string, string[]][] = [
    ["e-omp", "new", "ready", OMP],
    ["e-ome", "assigned", "in_progress", OME],
    ["e-om", "submitted", "approved", OM],
    ["e-e", "in_progress", "submitted", E],
    ["e-ompe", "assigned", "ready", OMPE],
  ];
  for (const [id, from, to, roles] of edges) {
    await c.query(
      `INSERT INTO workflow_transitions (id, organisation_id, workflow_id, from_status_id, to_status_id, label, allowed_roles, created_at, updated_at)
       VALUES ($1, 'a', 'a-wf', $2, $3, $1, $4::jsonb, $5, $5)`,
      [id, `a-st-${from}`, `a-st-${to}`, JSON.stringify(roles), T0],
    );
  }
  await c.query(
    `INSERT INTO job_types (id, organisation_id, name, workflow_id, created_at, updated_at) VALUES ('a-jt', 'a', 'Real Estate', 'a-wf', $1, $1)`,
    [T0],
  );
  await c.query(`INSERT INTO clients (id, organisation_id, name, created_at, updated_at) VALUES ('a-c', 'a', 'Harbour', $1, $1)`, [T0]);
  await c.query(`INSERT INTO projects (id, organisation_id, client_id, name, created_at, updated_at) VALUES ('a-pr', 'a', 'a-c', '1 Smith St', $1, $1)`, [T0]);
  // a job in "new" with its creation transition + job.created event (zero drift)
  await c.query(
    `INSERT INTO jobs (id, organisation_id, job_number, name, client_id, project_id, job_type_id, workflow_id, status_id, status_category,
                       status_entered_at, last_activity_at, created_by_user_id, created_at, updated_at)
     VALUES ('a-job', 'a', 'PJ-0001', 'Legacy job', 'a-c', 'a-pr', 'a-jt', 'a-wf', 'a-st-new', 'new', $1, $1, 'a-m1', $1, $1)`,
    [at(10)],
  );
  await c.query(`UPDATE organisations SET job_sequence = 1 WHERE id = 'a'`);
  await c.query(
    `INSERT INTO job_status_transitions (id, organisation_id, job_id, sequence, kind, to_status_id, to_category, status_name, actor_user_id, entered_at)
     VALUES ('a-tr', 'a', 'a-job', 1, 'creation', 'a-st-new', 'new', 'new', 'a-m1', $1)`,
    [at(10)],
  );
  await c.query(
    `INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action, summary, created_at)
     VALUES ('a-ev', 'a', 'a-m1', 'a-job', 'job', 'a-job', 'job.created', 'created', 'Created the job', $1)`,
    [at(10)],
  );
  // links: added by the owner (→ added_by_sharer) and by an editor (→ not)
  for (const [id, by] of [
    ["l-owner", "a-owner"],
    ["l-editor", "a-e1"],
    ["l-manager", "a-m1"],
  ]) {
    await c.query(
      `INSERT INTO job_links (id, organisation_id, job_id, kind, url, added_by_user_id, created_at)
       VALUES ($1, 'a', 'a-job', 'gallery', 'https://example.com/' || $1, $2, $3)`,
      [id, by, at(11)],
    );
  }
  // automations: legacy notify targets, plus one row whose actions are not an array
  const trigger = JSON.stringify({ type: "job_overdue" });
  await c.query(
    `INSERT INTO automations (id, organisation_id, name, trigger_type, trigger, actions, created_by_user_id, created_at, updated_at)
     VALUES ('au-1', 'a', 'Notify', 'job_overdue', $1::jsonb, $2::jsonb, 'a-owner', $3, $3)`,
    [
      trigger,
      JSON.stringify([
        { type: "notify", target: "managers", message: "m" },
        { type: "notify", target: "owner" },
        { type: "notify", target: "photographer" },
        { type: "set_priority", priority: "high" },
      ]),
      T0,
    ],
  );
  await c.query(
    `INSERT INTO automations (id, organisation_id, name, trigger_type, trigger, actions, created_by_user_id, created_at, updated_at)
     VALUES ('au-2', 'a', 'Broken', 'job_overdue', $1::jsonb, '{"type":"notify","target":"managers"}'::jsonb, 'a-owner', $2, $2)`,
    [trigger, T0],
  );

  // ---- org B: the owner is inactive; managers ran it. Earliest photographer predates the manager.
  await insertOrg(c, "b");
  await insertUser(c, "b-owner", "b", "owner", 0, { active: false });
  await insertUser(c, "b-p1", "b", "photographer", 1);
  await insertUser(c, "b-m1", "b", "manager", 2);

  // ---- org C: no active photographer can become admin → 0003 must RAISE
  await insertOrg(c, "c");
  await insertUser(c, "c-owner", "c", "owner", 0, { active: false });
  await insertUser(c, "c-e1", "c", "editor", 1);
}

interface UserRow extends Record<string, unknown> {
  id: string;
  role: string;
  is_admin: boolean;
  can_create_jobs: boolean;
  can_view_all_jobs: boolean;
  can_assign_editors: boolean;
  can_review_submissions: boolean;
  can_view_team_workloads: boolean;
  can_view_analytics: boolean;
  can_view_team_jobs: boolean;
  version: number;
}

interface EventRow extends Record<string, unknown> {
  organisation_id: string;
  actor_user_id: string | null;
  entity_id: string;
  event_type: string;
  summary: string;
  visibility: string;
  metadata: Record<string, unknown>;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
}

describe("roles v2 migration (0002 + 0003) on a v1 database", () => {
  it("maps owner/manager/photographer/editor, edges, automations and links; aborts on an org without a possible admin", async () => {
    const { client, db } = await v1Database();
    await insertLegacyData(client);

    // Org C has nobody who can become admin: the whole migration (0002 + 0003) rolls back.
    let failure: unknown = null;
    try {
      await migrate(db, { migrationsFolder: migrationsFolder() });
    } catch (err) {
      failure = err;
    }
    expect(failure).not.toBeNull();
    expect(rootErrorMessage(failure)).toMatch(/roles v2: organisation\(s\) c have no active photographer to make admin; reactivate one first/);
    const stillV1 = await execRows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_admin'`,
    );
    expect(stillV1[0]?.n).toBe(0);

    // Fix the data (reactivate org C's owner) and migrate again.
    await client.query(`UPDATE users SET is_active = true WHERE id = 'c-owner'`);
    await migrate(db, { migrationsFolder: migrationsFolder() });

    const users = new Map((await execRows<UserRow>(db, sql`SELECT * FROM users ORDER BY id`)).map((u) => [u.id, u]));
    const u = (id: string) => {
      const row = users.get(id);
      if (!row) throw new Error(`missing ${id}`);
      return row;
    };

    // no legacy roles remain
    expect([...users.values()].every((x) => ["photographer", "editor", "client"].includes(x.role))).toBe(true);
    // owner → photographer + admin
    expect(u("a-owner")).toMatchObject({ role: "photographer", is_admin: true });
    // managers → team members with every switch on
    for (const id of ["a-m1", "a-m2", "b-m1"]) {
      expect(u(id)).toMatchObject({
        role: "photographer",
        can_create_jobs: true,
        can_view_all_jobs: true,
        can_assign_editors: true,
        can_review_submissions: true,
        can_view_team_workloads: true,
        can_view_analytics: true,
      });
    }
    expect(u("a-m1").is_admin).toBe(false);
    expect(u("a-m2").is_admin).toBe(false);
    expect(u("a-m1").version).toBe(2);
    // photographer: keeps flags; v1 org "see all jobs" → can_view_all_jobs; column defaults for the rest
    expect(u("a-p1")).toMatchObject({
      role: "photographer",
      is_admin: false,
      can_view_all_jobs: true,
      can_view_analytics: true,
      can_view_team_workloads: false,
      can_create_jobs: true,
      can_assign_editors: true,
      can_review_submissions: true,
    });
    // editors: create ✓, editors_see_team_jobs NOT migrated
    for (const id of ["a-e1", "a-e2", "a-e3"]) expect(u(id)).toMatchObject({ role: "editor", is_admin: false, can_create_jobs: true, can_view_team_jobs: false });
    // org B: the ex-manager (not the earlier photographer) was promoted
    expect(u("b-m1").is_admin).toBe(true);
    expect(u("b-p1").is_admin).toBe(false);
    expect(u("b-owner")).toMatchObject({ role: "photographer", is_admin: true });

    // primary owners: earliest active admin
    const settings = await execRows<{ organisation_id: string; primary_owner_user_id: string | null }>(
      db,
      sql`SELECT organisation_id, primary_owner_user_id FROM organisation_settings ORDER BY organisation_id`,
    );
    expect(settings).toEqual([
      { organisation_id: "a", primary_owner_user_id: "a-owner" },
      { organisation_id: "b", primary_owner_user_id: "b-m1" },
      { organisation_id: "c", primary_owner_user_id: "c-owner" },
    ]);

    // audit trail
    const events = await execRows<EventRow>(
      db,
      sql`SELECT organisation_id, actor_user_id, entity_id, event_type, summary, visibility, metadata, previous_value, new_value
            FROM activity_events WHERE metadata->>'migration' = '0003_roles_v2_data' ORDER BY event_type, entity_id`,
    );
    for (const e of events) {
      expect(e.actor_user_id).toBeNull();
      expect(e.visibility).toBe("management");
      expect(e.metadata.cause).toBe("migration");
    }
    const roleChanged = events.filter((e) => e.event_type === "user.role_changed");
    expect(roleChanged.map((e) => e.entity_id).sort()).toEqual(["a-m1", "a-m2", "a-owner", "b-m1", "b-owner", "c-owner"]);
    const ownerEvent = roleChanged.find((e) => e.entity_id === "a-owner");
    expect(ownerEvent?.summary).toBe("Role changed from Owner to Owner / Photographer (admin)");
    expect(ownerEvent?.previous_value).toEqual({ role: "owner" });
    expect(ownerEvent?.new_value).toEqual({ role: "photographer", isAdmin: true });
    const managerEvent = roleChanged.find((e) => e.entity_id === "a-m1");
    expect(managerEvent?.summary).toBe(
      "Role changed from Manager to Photographer (team member) with every team-member switch on; manages only their own jobs",
    );
    expect(managerEvent?.metadata.formerRole).toBe("manager");
    expect(managerEvent?.new_value).toEqual({ role: "photographer", isAdmin: false });
    const adminChanged = events.filter((e) => e.event_type === "user.admin_changed");
    expect(adminChanged.map((e) => [e.organisation_id, e.entity_id, e.metadata.reason])).toEqual([["b", "b-m1", "no_active_owner"]]);
    expect(adminChanged[0]?.summary).toBe("Made an admin because the organisation had no active owner");
    const settingsEvents = events.filter((e) => e.event_type === "settings.updated");
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0]?.organisation_id).toBe("a");
    expect(settingsEvents[0]?.metadata.editorIds).toEqual(["a-e1", "a-e2"]);

    // links: added_by_sharer for owner/manager adders only
    const links = await execRows<{ id: string; added_by_sharer: boolean; shared_with_client: boolean }>(
      db,
      sql`SELECT id, added_by_sharer, shared_with_client FROM job_links ORDER BY id`,
    );
    expect(links).toEqual([
      { id: "l-editor", added_by_sharer: false, shared_with_client: false },
      { id: "l-manager", added_by_sharer: true, shared_with_client: false },
      { id: "l-owner", added_by_sharer: true, shared_with_client: false },
    ]);

    // workflow edges: lossless mapping (§5.1)
    const edges = new Map(
      (await execRows<{ id: string; allowed_roles: string[] }>(db, sql`SELECT id, allowed_roles FROM workflow_transitions`)).map((e) => [
        e.id,
        e.allowed_roles,
      ]),
    );
    expect(edges.get("e-omp")).toEqual(["photographer"]);
    expect(edges.get("e-ome")).toEqual(["admin", "editor"]);
    expect(edges.get("e-om")).toEqual(["admin"]);
    expect(edges.get("e-e")).toEqual(["editor"]);
    expect(edges.get("e-ompe")).toEqual(["editor", "photographer"]);

    // automations: managers/owner → admins; non-array actions untouched
    const autos = new Map(
      (await execRows<{ id: string; actions: unknown }>(db, sql`SELECT id, actions FROM automations`)).map((a) => [a.id, a.actions]),
    );
    expect(autos.get("au-1")).toEqual([
      { type: "notify", target: "admins", message: "m" },
      { type: "notify", target: "admins" },
      { type: "notify", target: "photographer" },
      { type: "set_priority", priority: "high" },
    ]);
    expect(autos.get("au-2")).toEqual({ type: "notify", target: "managers" });

    // jobs: legacy rows are photographer-created and unshared
    const jobs = await execRows<{ created_by_role: string; shared_with_client: boolean }>(db, sql`SELECT created_by_role, shared_with_client FROM jobs`);
    expect(jobs).toEqual([{ created_by_role: "photographer", shared_with_client: false }]);

    // triggers: 33 row-level guards (+ TRUNCATE guards) known; the ones 0001–0003 install are present
    expect(ROW_GUARDS).toHaveLength(33);
    expect((await listInstalledGuards(db)).sort()).toEqual(GUARDS.map((g) => g.name).sort());

    // zero drift
    const report = await verifyDerived(db);
    expect(report.drift).toEqual([]);
  }, 60_000);

  it("installs CHECK constraints and the admin / client / primary-owner / link guards", async () => {
    const { client, db } = await v1Database();
    await insertOrg(client, "a");
    await insertUser(client, "a-owner", "a", "owner", 0);
    await insertUser(client, "a-m1", "a", "manager", 1);
    await insertUser(client, "a-e1", "a", "editor", 2);
    await client.query(`INSERT INTO clients (id, organisation_id, name, created_at, updated_at) VALUES ('a-c', 'a', 'Harbour', $1, $1)`, [T0]);
    await client.query(`INSERT INTO clients (id, organisation_id, name, created_at, updated_at) VALUES ('a-c2', 'a', 'Coastal', $1, $1)`, [T0]);
    await insertOrg(client, "z");
    await insertUser(client, "z-owner", "z", "owner", 0);
    await client.query(`INSERT INTO clients (id, organisation_id, name, created_at, updated_at) VALUES ('z-c', 'z', 'Other', $1, $1)`, [T0]);
    await migrate(db, { migrationsFolder: migrationsFolder() });

    const reject = async (text: string, params: unknown[] = []): Promise<unknown> => {
      try {
        await client.query(text, params);
      } catch (err) {
        return err;
      }
      throw new Error(`expected rejection: ${text}`);
    };
    const newUser = (id: string, role: string, extra = "", extraValues = "") =>
      `INSERT INTO users (id, organisation_id, email, password_hash, name, role, created_at, updated_at${extra})
       VALUES ('${id}', 'a', '${id}@x.test', 'x', '${id}', '${role}', '${T0}', '${T0}'${extraValues})`;

    // CHECKs
    expect(isCheckViolation(await reject(newUser("bad-role", "manager")), "users_role_ck")).toBe(true);
    expect(isCheckViolation(await reject(newUser("bad-admin", "editor", ", is_admin", ", true")), "users_admin_photographer_ck")).toBe(true);
    expect(isCheckViolation(await reject(newUser("bad-client", "client")), "users_client_id_ck")).toBe(true);
    expect(isCheckViolation(await reject(newUser("bad-staff", "editor", ", client_id", ", 'a-c'")), "users_client_id_ck")).toBe(true);

    // users_client_link: a client user must belong to a client of their org; client_id is immutable
    const foreign = await reject(newUser("cu-foreign", "client", ", client_id", ", 'z-c'"));
    expect(isGuardViolation(foreign)).toBe(true);
    expect(rootErrorMessage(foreign)).toBe("client users must belong to a client of their organisation");
    await client.query(newUser("cu-1", "client", ", client_id", ", 'a-c'"));
    expect(rootErrorMessage(await reject(`UPDATE users SET client_id = 'a-c2' WHERE id = 'cu-1'`))).toBe("a client user cannot be moved to another client");

    // users_keep_admin + org_primary_owner
    expect(rootErrorMessage(await reject(`UPDATE users SET is_admin = false WHERE id = 'a-owner'`))).toBe(
      "the primary owner must stay an active admin; transfer primary ownership first",
    );
    await client.query(`UPDATE users SET is_admin = true WHERE id = 'a-m1'`);
    expect(rootErrorMessage(await reject(`UPDATE organisation_settings SET primary_owner_user_id = 'a-e1' WHERE organisation_id = 'a'`))).toBe(
      "the primary owner must be an active admin of the organisation",
    );
    expect(rootErrorMessage(await reject(`UPDATE organisation_settings SET primary_owner_user_id = NULL WHERE organisation_id = 'a'`))).toBe(
      "the primary owner cannot be cleared",
    );
    await client.query(`UPDATE organisation_settings SET primary_owner_user_id = 'a-m1' WHERE organisation_id = 'a'`);
    // the old owner can now be demoted (another active admin remains) …
    await client.query(`UPDATE users SET is_admin = false WHERE id = 'a-owner'`);
    // … but the last active admin cannot be deactivated (it is also the primary owner: that message wins)
    expect(rootErrorMessage(await reject(`UPDATE users SET is_active = false WHERE id = 'a-m1'`))).toBe(
      "the primary owner must stay an active admin; transfer primary ownership first",
    );
    // the last-admin rule on its own: move the primary-owner pointer off (trigger dropped for the test) and demote the last admin
    await client.query(`UPDATE users SET is_admin = true WHERE id = 'a-owner'`);
    await client.query(`UPDATE organisation_settings SET primary_owner_user_id = 'a-owner' WHERE organisation_id = 'a'`);
    await client.query(`UPDATE users SET is_admin = false WHERE id = 'a-m1'`);
    expect(rootErrorMessage(await reject(`UPDATE users SET role = 'editor', is_admin = false WHERE id = 'a-owner'`))).toBe(
      "the primary owner must stay an active admin; transfer primary ownership first",
    );
    await client.query(`DROP TRIGGER org_primary_owner ON organisation_settings`);
    await client.query(`UPDATE organisation_settings SET primary_owner_user_id = 'a-m1' WHERE organisation_id = 'a'`);
    expect(rootErrorMessage(await reject(`UPDATE users SET is_admin = false WHERE id = 'a-owner'`))).toBe(
      "an organisation must keep at least one active admin",
    );
  }, 60_000);
});
