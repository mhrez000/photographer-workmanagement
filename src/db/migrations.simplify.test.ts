/**
 * Simplified-UI migration (drizzle/0004_simplify.sql, docs/SIMPLIFICATION-PLAN.md §8 "Safety for existing
 * studios"). Boots PGlite at migration 0003 (the roles-v2 schema), inserts organisations in the four
 * situations the auto-enable rule distinguishes, applies 0004 and asserts: Advanced tools turns on ONLY
 * for a studio with a non-default workflow bound to a job type that has jobs, or with an enabled
 * automation; the switch is audited; staff of automation studios keep their `automation` notices; the
 * new nullable columns default right; zero drift.
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
import { verifyDerived } from "./verify";

const opened: PGlite[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => (c.closed ? Promise.resolve() : c.close())));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A migrations folder holding only the first `count` committed migrations. */
function partialMigrationsFolder(count: number): string {
  const src = migrationsFolder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwm-simplify-pre-"));
  tempDirs.push(dir);
  const journal = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx < count);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  for (const e of entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

async function preSimplifyDatabase() {
  const client = await PGlite.create({ parsers: PGLITE_PARSERS });
  opened.push(client);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: partialMigrationsFolder(4) });
  return { client, db };
}

const T0 = "2026-01-01T00:00:00.000Z";
type Q = { query: (text: string, params?: unknown[]) => Promise<unknown> };

/** An organisation with its admin owner (roles v2 shape), settings row and primary owner. */
async function insertOrg(c: Q, id: string) {
  await c.query(`INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES ($1, $1, $1, $2, $2)`, [id, T0]);
  await c.query(`INSERT INTO organisation_settings (organisation_id, updated_at) VALUES ($1, $2)`, [id, T0]);
  await c.query(
    `INSERT INTO users (id, organisation_id, email, password_hash, name, role, is_admin, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $1, 'photographer', true, $4, $4)`,
    [`${id}-owner`, id, `${id}-owner@legacy.test`, T0],
  );
  await c.query(
    `INSERT INTO users (id, organisation_id, email, password_hash, name, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $1, 'editor', $4, $4)`,
    [`${id}-editor`, id, `${id}-editor@legacy.test`, T0],
  );
  await c.query(
    `INSERT INTO users (id, organisation_id, email, password_hash, name, role, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, 'x', $1, 'editor', false, $4, $4)`,
    [`${id}-gone`, id, `${id}-gone@legacy.test`, T0],
  );
  await c.query(`UPDATE organisation_settings SET primary_owner_user_id = $1 WHERE organisation_id = $2`, [`${id}-owner`, id]);
}

/** A workflow (default or custom) with a `new` status, a job type bound to it and optionally a job in it. */
async function insertWorkflow(c: Q, org: string, key: string, isDefault: boolean, withJob: boolean) {
  const wf = `${org}-${key}-wf`;
  await c.query(`INSERT INTO workflows (id, organisation_id, name, is_default, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, [wf, org, key, isDefault, T0]);
  const st = `${wf}-new`;
  await c.query(
    `INSERT INTO workflow_statuses (id, organisation_id, workflow_id, key, name, category, sort_order, is_initial, created_at, updated_at)
     VALUES ($1, $2, $3, 'new', 'New', 'new', 0, true, $4, $4)`,
    [st, org, wf, T0],
  );
  const jt = `${wf}-jt`;
  await c.query(`INSERT INTO job_types (id, organisation_id, name, workflow_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, [jt, org, `${key} type`, wf, T0]);
  if (!withJob) return;
  const client = `${org}-${key}-client`;
  await c.query(`INSERT INTO clients (id, organisation_id, name, created_at, updated_at) VALUES ($1, $2, $1, $3, $3)`, [client, org, T0]);
  const project = `${org}-${key}-project`;
  await c.query(`INSERT INTO projects (id, organisation_id, client_id, name, created_at, updated_at) VALUES ($1, $2, $3, '1 Smith St', $4, $4)`, [project, org, client, T0]);
  const job = `${org}-${key}-job`;
  await c.query(`UPDATE organisations SET job_sequence = job_sequence + 1 WHERE id = $1`, [org]);
  await c.query(
    `INSERT INTO jobs (id, organisation_id, job_number, name, client_id, project_id, job_type_id, workflow_id, status_id, status_category,
                       status_entered_at, last_activity_at, created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'Legacy job', $4, $5, $6, $7, $8, 'new', $9, $9, $10, $9, $9)`,
    [job, org, `PJ-${key.slice(0, 4).toUpperCase()}`, client, project, jt, wf, st, T0, `${org}-owner`],
  );
  await c.query(
    `INSERT INTO job_status_transitions (id, organisation_id, job_id, sequence, kind, to_status_id, to_category, status_name, actor_user_id, entered_at)
     VALUES ($1, $2, $3, 1, 'creation', $4, 'new', 'New', $5, $6)`,
    [`${job}-tr`, org, job, st, `${org}-owner`, T0],
  );
  await c.query(
    `INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action, summary, created_at)
     VALUES ($1, $2, $3, $4, 'job', $4, 'job.created', 'created', 'created the job', $5)`,
    [`${job}-ev`, org, `${org}-owner`, job, T0],
  );
}

async function insertAutomation(c: Q, org: string, enabled: boolean, archived = false) {
  await c.query(
    `INSERT INTO automations (id, organisation_id, name, is_enabled, trigger_type, trigger, actions, created_by_user_id, archived_at, created_at, updated_at)
     VALUES ($1, $2, 'Rule', $3, 'job_overdue', '{"type":"job_overdue"}'::jsonb, '[{"type":"notify","target":"admins"}]'::jsonb, $4, $5, $6, $6)`,
    [`${org}-au-${enabled}-${archived}`, org, enabled, `${org}-owner`, archived ? T0 : null, T0],
  );
}

describe("0004_simplify on a roles-v2 database", () => {
  it("turns Advanced tools on only for studios that use a custom workflow (with jobs) or an enabled automation, audited; keeps automation notices on for those staff", async () => {
    const { client, db } = await preSimplifyDatabase();
    // A: default workflow only, no automations → stays off
    await insertOrg(client, "a");
    await insertWorkflow(client, "a", "default", true, true);
    // B: a custom workflow bound to a job type WITH a job → on
    await insertOrg(client, "b");
    await insertWorkflow(client, "b", "default", true, false);
    await insertWorkflow(client, "b", "custom", false, true);
    // C: a custom workflow bound to a job type WITHOUT jobs → off
    await insertOrg(client, "c");
    await insertWorkflow(client, "c", "default", true, true);
    await insertWorkflow(client, "c", "custom", false, false);
    // D: an enabled automation → on (+ automation notice rows for its active staff)
    await insertOrg(client, "d");
    await insertWorkflow(client, "d", "default", true, false);
    await insertAutomation(client, "d", true);
    // E: only disabled / archived automations → off
    await insertOrg(client, "e");
    await insertWorkflow(client, "e", "default", true, false);
    await insertAutomation(client, "e", false);
    await insertAutomation(client, "e", true, true);

    const before = await execRows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'organisation_settings' AND column_name = 'advanced_tools_enabled'`);
    expect(before[0]?.n).toBe(0);

    await migrate(db, { migrationsFolder: migrationsFolder() });

    const settings = await execRows<{ organisation_id: string; advanced_tools_enabled: boolean; version: number }>(
      db,
      sql`SELECT organisation_id, advanced_tools_enabled, version FROM organisation_settings ORDER BY organisation_id`,
    );
    expect(settings).toEqual([
      { organisation_id: "a", advanced_tools_enabled: false, version: 1 },
      { organisation_id: "b", advanced_tools_enabled: true, version: 2 },
      { organisation_id: "c", advanced_tools_enabled: false, version: 1 },
      { organisation_id: "d", advanced_tools_enabled: true, version: 2 },
      { organisation_id: "e", advanced_tools_enabled: false, version: 1 },
    ]);

    // audit: one management settings.updated per auto-enabled org, actor NULL, cause migration
    const events = await execRows<{ organisation_id: string; actor_user_id: string | null; visibility: string; metadata: Record<string, unknown>; new_value: Record<string, unknown>; summary: string }>(
      db,
      sql`SELECT organisation_id, actor_user_id, visibility, metadata, new_value, summary FROM activity_events WHERE metadata->>'migration' = '0004_simplify' ORDER BY organisation_id`,
    );
    expect(events.map((e) => e.organisation_id)).toEqual(["b", "d"]);
    for (const e of events) {
      expect(e.actor_user_id).toBeNull();
      expect(e.visibility).toBe("management");
      expect(e.metadata).toMatchObject({ cause: "migration", field: "advancedToolsEnabled", reason: "uses_custom_workflow_or_automations" });
      expect(e.new_value).toEqual({ field: "advancedToolsEnabled", value: true });
      expect(e.summary).toMatch(/Advanced tools/);
    }

    // automation notices stay on for the active staff of org D only (not the deactivated editor, not other orgs)
    const prefs = await execRows<{ user_id: string; type: string; enabled: boolean }>(db, sql`SELECT user_id, type, enabled FROM user_notification_prefs ORDER BY user_id`);
    expect(prefs).toEqual([
      { user_id: "d-editor", type: "automation", enabled: true },
      { user_id: "d-owner", type: "automation", enabled: true },
    ]);

    // new nullable columns default to null; re-running the data rule is idempotent (migrator would not, but the SQL is)
    const nulls = await execRows<{ u: number; j: number; s: number }>(
      db,
      sql`SELECT (SELECT count(*)::int FROM users WHERE usual_capacity_jobs IS NOT NULL) AS u,
                 (SELECT count(*)::int FROM job_types WHERE usual_days_to_edit IS NOT NULL) AS j,
                 (SELECT count(*)::int FROM users WHERE simpler_notice_dismissed_at IS NOT NULL) AS s`,
    );
    expect(nulls[0]).toEqual({ u: 0, j: 0, s: 0 });

    const report = await verifyDerived(db);
    expect(report.drift).toEqual([]);
    expect(report.structural).toEqual([]);
  }, 60_000);
});
