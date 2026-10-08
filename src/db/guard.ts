/**
 * DB-level integrity guards (SQLite triggers).
 *
 * drizzle-kit does not manage triggers, so they live here as SQL and are
 * installed idempotently (DROP IF EXISTS + CREATE inside one transaction)
 * by: `src/db/index.ts` on open (when tables exist), `npm run db:guard`,
 * `src/db/reset.ts`, `src/db/seed.ts`, and the vitest `makeTestDb()` helper.
 *
 * Layers of protection (ARCHITECTURE.md §5.4):
 *   1. append-only ledgers: activity_events (no UPDATE, no DELETE at all)
 *   2. fill-once ledgers: only the designated "close" columns may change,
 *      exactly once, from NULL
 *   3. no hard deletes of jobs / users (cancel / deactivate instead)
 *   4. jobs consistency: status belongs to the job's workflow, status_category
 *      matches the status, client matches the project, and every status_id
 *      change must already have its open job_status_transitions row
 *      (so a status change can never happen without its ledger row)
 *
 * Run directly: `tsx src/db/guard.ts` (uses DATABASE_PATH).
 */
import type Database from "better-sqlite3";

export interface GuardDefinition {
  name: string;
  table: string;
  sql: string;
}

const abort = (msg: string) => `BEGIN SELECT RAISE(ABORT, '${msg}'); END;`;

export const GUARDS: readonly GuardDefinition[] = [
  /* ---------------- activity_events: pure append-only ---------------- */
  {
    name: "ae_no_update",
    table: "activity_events",
    sql: `CREATE TRIGGER ae_no_update BEFORE UPDATE ON activity_events ${abort("activity_events is append-only")}`,
  },
  {
    name: "ae_no_delete",
    table: "activity_events",
    sql: `CREATE TRIGGER ae_no_delete BEFORE DELETE ON activity_events ${abort("activity_events is append-only")}`,
  },

  /* ---------------- job_status_transitions: exited_at/duration fill-once ---------------- */
  {
    name: "jst_no_delete",
    table: "job_status_transitions",
    sql: `CREATE TRIGGER jst_no_delete BEFORE DELETE ON job_status_transitions ${abort("job_status_transitions is append-only")}`,
  },
  {
    name: "jst_fill_once",
    table: "job_status_transitions",
    sql: `CREATE TRIGGER jst_fill_once BEFORE UPDATE ON job_status_transitions
      WHEN OLD.exited_at IS NOT NULL
        OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.sequence <> OLD.sequence OR NEW.kind <> OLD.kind
        OR NEW.from_status_id IS NOT OLD.from_status_id OR NEW.to_status_id <> OLD.to_status_id
        OR NEW.from_category IS NOT OLD.from_category OR NEW.to_category <> OLD.to_category
        OR NEW.status_name <> OLD.status_name OR NEW.actor_user_id IS NOT OLD.actor_user_id
        OR NEW.automation_run_id IS NOT OLD.automation_run_id OR NEW.reason IS NOT OLD.reason
        OR NEW.is_reopen <> OLD.is_reopen OR NEW.is_override <> OLD.is_override
        OR NEW.entered_at <> OLD.entered_at
        OR NEW.editor_id_at_entry IS NOT OLD.editor_id_at_entry
        OR NEW.photographer_id_at_entry IS NOT OLD.photographer_id_at_entry
        OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS NOT OLD.activity_event_id)
      ${abort("transition rows are immutable except exited_at/duration_seconds (fill-once) and activity_event_id (set once)")}`,
  },

  /* ---------------- job_assignments: unassigned_* fill-once ---------------- */
  {
    name: "ja_no_delete",
    table: "job_assignments",
    sql: `CREATE TRIGGER ja_no_delete BEFORE DELETE ON job_assignments ${abort("job_assignments is append-only")}`,
  },
  {
    name: "ja_fill_once",
    table: "job_assignments",
    sql: `CREATE TRIGGER ja_fill_once BEFORE UPDATE ON job_assignments
      WHEN OLD.unassigned_at IS NOT NULL
        OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.role <> OLD.role OR NEW.user_id <> OLD.user_id
        OR NEW.assigned_by_user_id IS NOT OLD.assigned_by_user_id OR NEW.assigned_at <> OLD.assigned_at
        OR NEW.reason IS NOT OLD.reason OR NEW.status_category_at_assign IS NOT OLD.status_category_at_assign
        OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS NOT OLD.activity_event_id)
      ${abort("assignment rows are immutable except unassigned_* (fill-once)")}`,
  },

  /* ---------------- job_revisions: resolved_* fill-once ---------------- */
  {
    name: "jr_no_delete",
    table: "job_revisions",
    sql: `CREATE TRIGGER jr_no_delete BEFORE DELETE ON job_revisions ${abort("job_revisions is append-only")}`,
  },
  {
    name: "jr_fill_once",
    table: "job_revisions",
    sql: `CREATE TRIGGER jr_fill_once BEFORE UPDATE ON job_revisions
      WHEN OLD.resolved_at IS NOT NULL
        OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.revision_number <> OLD.revision_number OR NEW.requested_by_user_id <> OLD.requested_by_user_id
        OR NEW.reason <> OLD.reason OR NEW.description <> OLD.description
        OR NEW.requested_at <> OLD.requested_at
        OR NEW.request_transition_id IS NOT OLD.request_transition_id
        OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS NOT OLD.activity_event_id)
      ${abort("revision rows are immutable except assignee/instructions/priority/due_date while open and resolved_* (fill-once)")}`,
  },

  /* ---------------- job_links: supersede/remove fill-once; content immutable ---------------- */
  {
    name: "jl_no_delete",
    table: "job_links",
    sql: `CREATE TRIGGER jl_no_delete BEFORE DELETE ON job_links ${abort("job_links is append-only")}`,
  },
  {
    name: "jl_fill_once",
    table: "job_links",
    sql: `CREATE TRIGGER jl_fill_once BEFORE UPDATE ON job_links
      WHEN NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.kind <> OLD.kind OR NEW.url <> OLD.url OR NEW.label IS NOT OLD.label
        OR NEW.provider IS NOT OLD.provider
        OR NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.created_at <> OLD.created_at
        OR NEW.supersedes_link_id IS NOT OLD.supersedes_link_id
        OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NOT OLD.superseded_at)
        OR (OLD.superseded_by_link_id IS NOT NULL AND NEW.superseded_by_link_id IS NOT OLD.superseded_by_link_id)
        OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
        OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS NOT OLD.activity_event_id)
      ${abort("link rows are immutable; replace by superseding or remove once")}`,
  },

  /* ---------------- job_comments: permanent; edit stamps edited_at; soft-delete fill-once ---------------- */
  {
    name: "jc_no_delete",
    table: "job_comments",
    sql: `CREATE TRIGGER jc_no_delete BEFORE DELETE ON job_comments ${abort("job_comments are permanent (soft-delete only)")}`,
  },
  {
    name: "jc_guard",
    table: "job_comments",
    sql: `CREATE TRIGGER jc_guard BEFORE UPDATE ON job_comments
      WHEN NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.author_user_id <> OLD.author_user_id OR NEW.created_at <> OLD.created_at
        OR NEW.parent_comment_id IS NOT OLD.parent_comment_id OR NEW.root_comment_id IS NOT OLD.root_comment_id
        OR NEW.kind <> OLD.kind OR NEW.revision_id IS NOT OLD.revision_id
        OR (NEW.body <> OLD.body AND (NEW.edited_at IS NULL OR NEW.edit_count <= OLD.edit_count))
        OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
        OR (OLD.deleted_at IS NOT NULL AND NEW.body <> OLD.body)
      ${abort("comment edits must stamp edited_at and bump edit_count; soft-delete is fill-once")}`,
  },

  /* ---------------- work_sessions: ended_* fill-once ---------------- */
  {
    name: "ws_no_delete",
    table: "work_sessions",
    sql: `CREATE TRIGGER ws_no_delete BEFORE DELETE ON work_sessions ${abort("work_sessions is append-only")}`,
  },
  {
    name: "ws_fill_once",
    table: "work_sessions",
    sql: `CREATE TRIGGER ws_fill_once BEFORE UPDATE ON work_sessions
      WHEN OLD.ended_at IS NOT NULL
        OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.job_id <> OLD.job_id
        OR NEW.user_id <> OLD.user_id OR NEW.status_id_at_start <> OLD.status_id_at_start
        OR NEW.category_at_start <> OLD.category_at_start OR NEW.transition_id <> OLD.transition_id
        OR NEW.started_at <> OLD.started_at
      ${abort("work session rows are immutable except ended_at/end_reason/duration_seconds/note (fill-once)")}`,
  },

  /* ---------------- automation_runs: no delete; identity immutable ---------------- */
  {
    name: "ar_no_delete",
    table: "automation_runs",
    sql: `CREATE TRIGGER ar_no_delete BEFORE DELETE ON automation_runs ${abort("automation_runs is append-only")}`,
  },
  {
    name: "ar_guard",
    table: "automation_runs",
    sql: `CREATE TRIGGER ar_guard BEFORE UPDATE ON automation_runs
      WHEN NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id
        OR NEW.automation_id <> OLD.automation_id OR NEW.trigger_event_id <> OLD.trigger_event_id
        OR NEW.job_id IS NOT OLD.job_id OR NEW.depth <> OLD.depth OR NEW.created_at <> OLD.created_at
        OR (OLD.finished_at IS NOT NULL AND (NEW.finished_at IS NOT OLD.finished_at OR NEW.status <> OLD.status))
      ${abort("automation run identity is immutable; finished runs cannot change")}`,
  },

  /* ---------------- notifications: no delete; only read_at may change ---------------- */
  {
    name: "nt_no_delete",
    table: "notifications",
    sql: `CREATE TRIGGER nt_no_delete BEFORE DELETE ON notifications ${abort("notifications is append-only")}`,
  },
  {
    name: "nt_guard",
    table: "notifications",
    sql: `CREATE TRIGGER nt_guard BEFORE UPDATE ON notifications
      WHEN NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.user_id <> OLD.user_id
        OR NEW.type <> OLD.type OR NEW.title <> OLD.title OR NEW.body IS NOT OLD.body
        OR NEW.job_id IS NOT OLD.job_id OR NEW.actor_user_id IS NOT OLD.actor_user_id
        OR NEW.activity_event_id IS NOT OLD.activity_event_id OR NEW.link_path <> OLD.link_path
        OR NEW.dedupe_key IS NOT OLD.dedupe_key OR NEW.created_at <> OLD.created_at
      ${abort("only notifications.read_at may change")}`,
  },

  /* ---------------- team_memberships: no delete; left_at fill-once ---------------- */
  {
    name: "tm_no_delete",
    table: "team_memberships",
    sql: `CREATE TRIGGER tm_no_delete BEFORE DELETE ON team_memberships ${abort("team_memberships is append-only (set left_at)")}`,
  },
  {
    name: "tm_fill_once",
    table: "team_memberships",
    sql: `CREATE TRIGGER tm_fill_once BEFORE UPDATE ON team_memberships
      WHEN OLD.left_at IS NOT NULL
        OR NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.team_id <> OLD.team_id
        OR NEW.user_id <> OLD.user_id OR NEW.joined_at <> OLD.joined_at
        OR NEW.added_by_user_id IS NOT OLD.added_by_user_id
      ${abort("membership rows are immutable except left_at/removed_by (fill-once)")}`,
  },

  /* ---------------- jobs / users: never hard-deleted ---------------- */
  {
    name: "jobs_no_delete",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_no_delete BEFORE DELETE ON jobs ${abort("jobs cannot be deleted; cancel instead")}`,
  },
  {
    name: "users_no_delete",
    table: "users",
    sql: `CREATE TRIGGER users_no_delete BEFORE DELETE ON users ${abort("users cannot be deleted; deactivate or anonymise instead")}`,
  },

  /* ---------------- jobs consistency ---------------- */
  {
    name: "jobs_status_in_workflow_ins",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_status_in_workflow_ins BEFORE INSERT ON jobs
      WHEN (SELECT workflow_id FROM workflow_statuses WHERE id = NEW.status_id) IS NOT NEW.workflow_id
        OR (SELECT category FROM workflow_statuses WHERE id = NEW.status_id) IS NOT NEW.status_category
      ${abort("jobs.status_id must belong to jobs.workflow_id and status_category must match the status")}`,
  },
  {
    name: "jobs_status_in_workflow_upd",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_status_in_workflow_upd BEFORE UPDATE OF status_id, workflow_id, status_category ON jobs
      WHEN (SELECT workflow_id FROM workflow_statuses WHERE id = NEW.status_id) IS NOT NEW.workflow_id
        OR (SELECT category FROM workflow_statuses WHERE id = NEW.status_id) IS NOT NEW.status_category
      ${abort("jobs.status_id must belong to jobs.workflow_id and status_category must match the status")}`,
  },
  {
    name: "jobs_client_matches_project_ins",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_client_matches_project_ins BEFORE INSERT ON jobs
      WHEN (SELECT client_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.client_id
      ${abort("jobs.client_id must equal projects.client_id of jobs.project_id")}`,
  },
  {
    name: "jobs_client_matches_project_upd",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_client_matches_project_upd BEFORE UPDATE OF client_id, project_id ON jobs
      WHEN (SELECT client_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.client_id
      ${abort("jobs.client_id must equal projects.client_id of jobs.project_id")}`,
  },
  {
    name: "jobs_status_change_needs_transition",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_status_change_needs_transition BEFORE UPDATE OF status_id ON jobs
      WHEN NEW.status_id <> OLD.status_id
        AND NOT EXISTS (
          SELECT 1 FROM job_status_transitions
          WHERE job_id = NEW.id AND to_status_id = NEW.status_id AND exited_at IS NULL
        )
      ${abort("jobs.status_id can only change after its open job_status_transitions row exists (use transitionJobStatus)")}`,
  },
  {
    name: "jobs_org_immutable",
    table: "jobs",
    sql: `CREATE TRIGGER jobs_org_immutable BEFORE UPDATE OF organisation_id, job_number, created_by_user_id, created_at ON jobs
      WHEN NEW.organisation_id <> OLD.organisation_id OR NEW.job_number <> OLD.job_number
        OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at
      ${abort("jobs.organisation_id / job_number / created_by / created_at are immutable")}`,
  },
];

/** Tables that must exist before guards can be installed. */
export const GUARDED_TABLES: readonly string[] = Array.from(new Set(GUARDS.map((g) => g.table)));

/** True when every guarded table exists (i.e. `drizzle-kit push` has run). */
export function tablesExist(sqlite: Database.Database): boolean {
  const rows = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];
  const names = new Set(rows.map((r) => r.name));
  return GUARDED_TABLES.every((t) => names.has(t));
}

/**
 * Installs every guard trigger idempotently: each one is dropped and
 * re-created inside a single transaction, so re-running after a change to
 * this file always yields the current definitions.
 */
export function installGuards(sqlite: Database.Database): { installed: number } {
  if (!tablesExist(sqlite)) {
    throw new Error("installGuards: tables are missing — run `npm run db:push` first");
  }
  const run = sqlite.transaction(() => {
    for (const guard of GUARDS) {
      sqlite.exec(`DROP TRIGGER IF EXISTS ${guard.name};`);
      sqlite.exec(guard.sql);
    }
  });
  run();
  return { installed: GUARDS.length };
}

/** Names of the guard triggers currently present in the database. */
export function listInstalledGuards(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all() as { name: string }[];
  const known = new Set(GUARDS.map((g) => g.name));
  return rows.map((r) => r.name).filter((n) => known.has(n));
}

/* ------------------------------------------------------------------ */
/*  CLI entry: `tsx src/db/guard.ts`                                     */
/* ------------------------------------------------------------------ */

const isDirectRun =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /[\\/]guard\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  // Lazy import avoids a circular import at module-evaluation time for app code.
  void import("./index").then(({ sqlite, DEFAULT_DATABASE_PATH }) => {
    const { installed } = installGuards(sqlite);
    process.stdout.write(
      `guards: installed ${installed} triggers on ${process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH}\n`,
    );
  });
}
