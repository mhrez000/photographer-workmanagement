-- Integrity guards (ARCHITECTURE.md §2.7 / §5.4) — the single source of truth.
-- drizzle-kit does not model triggers, so this is a custom migration
-- (`npx drizzle-kit generate --custom`). Every function is CREATE OR REPLACE
-- and every trigger is DROP IF EXISTS + CREATE, so re-applying is idempotent.
--
-- Layers of protection:
--   1. append-only ledgers: activity_events (no UPDATE, no DELETE at all)
--   2. fill-once ledgers: only the designated "close" columns may change,
--      exactly once, from NULL
--   3. no hard deletes of jobs / users (cancel / deactivate instead)
--   4. jobs consistency: status belongs to the job's workflow, status_category
--      matches the status, client matches the project, and every status_id
--      change must already have its open job_status_transitions row
--   5. (Postgres only) no TRUNCATE of any guarded table: TRUNCATE bypasses
--      row-level DELETE triggers. `db:seed:remote --wipe` runs with
--      session_replication_role = replica, which skips these on purpose.
--
-- Messages are identical to the former SQLite RAISE(ABORT) texts; tests and
-- services match on them. All raise SQLSTATE P0001 (raise_exception).

/* ---------------- shared: unconditional reject (message = TG_ARGV[0]) ---------------- */
CREATE OR REPLACE FUNCTION guard_reject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$;
--> statement-breakpoint

/* ---------------- activity_events: pure append-only ---------------- */
DROP TRIGGER IF EXISTS ae_no_update ON activity_events;
--> statement-breakpoint
CREATE TRIGGER ae_no_update BEFORE UPDATE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION guard_reject('activity_events is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS ae_no_delete ON activity_events;
--> statement-breakpoint
CREATE TRIGGER ae_no_delete BEFORE DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION guard_reject('activity_events is append-only');
--> statement-breakpoint

/* ---------------- job_status_transitions: exited_at/duration fill-once ---------------- */
DROP TRIGGER IF EXISTS jst_no_delete ON job_status_transitions;
--> statement-breakpoint
CREATE TRIGGER jst_no_delete BEFORE DELETE ON job_status_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_reject('job_status_transitions is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jst_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.exited_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.from_status_id IS DISTINCT FROM OLD.from_status_id OR NEW.to_status_id IS DISTINCT FROM OLD.to_status_id
    OR NEW.from_category IS DISTINCT FROM OLD.from_category OR NEW.to_category IS DISTINCT FROM OLD.to_category
    OR NEW.status_name IS DISTINCT FROM OLD.status_name OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.automation_run_id IS DISTINCT FROM OLD.automation_run_id OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.is_reopen IS DISTINCT FROM OLD.is_reopen OR NEW.is_override IS DISTINCT FROM OLD.is_override
    OR NEW.entered_at IS DISTINCT FROM OLD.entered_at
    OR NEW.editor_id_at_entry IS DISTINCT FROM OLD.editor_id_at_entry
    OR NEW.photographer_id_at_entry IS DISTINCT FROM OLD.photographer_id_at_entry
    OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS DISTINCT FROM OLD.activity_event_id)
  THEN
    RAISE EXCEPTION 'transition rows are immutable except exited_at/duration_seconds (fill-once) and activity_event_id (set once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jst_fill_once ON job_status_transitions;
--> statement-breakpoint
CREATE TRIGGER jst_fill_once BEFORE UPDATE ON job_status_transitions
  FOR EACH ROW EXECUTE FUNCTION guard_jst_fill_once();
--> statement-breakpoint

/* ---------------- job_assignments: unassigned_* fill-once ---------------- */
DROP TRIGGER IF EXISTS ja_no_delete ON job_assignments;
--> statement-breakpoint
CREATE TRIGGER ja_no_delete BEFORE DELETE ON job_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_reject('job_assignments is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_ja_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unassigned_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.role IS DISTINCT FROM OLD.role OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.status_category_at_assign IS DISTINCT FROM OLD.status_category_at_assign
    OR NEW.rowid IS DISTINCT FROM OLD.rowid
    OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS DISTINCT FROM OLD.activity_event_id)
  THEN
    RAISE EXCEPTION 'assignment rows are immutable except unassigned_* (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ja_fill_once ON job_assignments;
--> statement-breakpoint
CREATE TRIGGER ja_fill_once BEFORE UPDATE ON job_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_ja_fill_once();
--> statement-breakpoint

/* ---------------- job_revisions: resolved_* fill-once ---------------- */
DROP TRIGGER IF EXISTS jr_no_delete ON job_revisions;
--> statement-breakpoint
CREATE TRIGGER jr_no_delete BEFORE DELETE ON job_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_reject('job_revisions is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jr_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.revision_number IS DISTINCT FROM OLD.revision_number OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.request_transition_id IS DISTINCT FROM OLD.request_transition_id
    OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS DISTINCT FROM OLD.activity_event_id)
  THEN
    RAISE EXCEPTION 'revision rows are immutable except assignee/instructions/priority/due_date while open and resolved_* (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jr_fill_once ON job_revisions;
--> statement-breakpoint
CREATE TRIGGER jr_fill_once BEFORE UPDATE ON job_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_jr_fill_once();
--> statement-breakpoint

/* ---------------- job_links: supersede/remove fill-once; content immutable ---------------- */
DROP TRIGGER IF EXISTS jl_no_delete ON job_links;
--> statement-breakpoint
CREATE TRIGGER jl_no_delete BEFORE DELETE ON job_links
  FOR EACH ROW EXECUTE FUNCTION guard_reject('job_links is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jl_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.url IS DISTINCT FROM OLD.url OR NEW.label IS DISTINCT FROM OLD.label
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.added_by_user_id IS DISTINCT FROM OLD.added_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.supersedes_link_id IS DISTINCT FROM OLD.supersedes_link_id
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
    OR (OLD.superseded_by_link_id IS NOT NULL AND NEW.superseded_by_link_id IS DISTINCT FROM OLD.superseded_by_link_id)
    OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at)
    OR (OLD.activity_event_id IS NOT NULL AND NEW.activity_event_id IS DISTINCT FROM OLD.activity_event_id)
  THEN
    RAISE EXCEPTION 'link rows are immutable; replace by superseding or remove once';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jl_fill_once ON job_links;
--> statement-breakpoint
CREATE TRIGGER jl_fill_once BEFORE UPDATE ON job_links
  FOR EACH ROW EXECUTE FUNCTION guard_jl_fill_once();
--> statement-breakpoint

/* ---------------- job_comments: permanent; edit stamps edited_at; soft-delete fill-once ---------------- */
DROP TRIGGER IF EXISTS jc_no_delete ON job_comments;
--> statement-breakpoint
CREATE TRIGGER jc_no_delete BEFORE DELETE ON job_comments
  FOR EACH ROW EXECUTE FUNCTION guard_reject('job_comments are permanent (soft-delete only)');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.parent_comment_id IS DISTINCT FROM OLD.parent_comment_id OR NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR (NEW.body IS DISTINCT FROM OLD.body AND (NEW.edited_at IS NULL OR NEW.edit_count <= OLD.edit_count))
    OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
    OR (OLD.deleted_at IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body)
  THEN
    RAISE EXCEPTION 'comment edits must stamp edited_at and bump edit_count; soft-delete is fill-once';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jc_guard ON job_comments;
--> statement-breakpoint
CREATE TRIGGER jc_guard BEFORE UPDATE ON job_comments
  FOR EACH ROW EXECUTE FUNCTION guard_jc_guard();
--> statement-breakpoint

/* ---------------- work_sessions: ended_* fill-once ---------------- */
DROP TRIGGER IF EXISTS ws_no_delete ON work_sessions;
--> statement-breakpoint
CREATE TRIGGER ws_no_delete BEFORE DELETE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_reject('work_sessions is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_ws_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.status_id_at_start IS DISTINCT FROM OLD.status_id_at_start
    OR NEW.category_at_start IS DISTINCT FROM OLD.category_at_start OR NEW.transition_id IS DISTINCT FROM OLD.transition_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
  THEN
    RAISE EXCEPTION 'work session rows are immutable except ended_at/end_reason/duration_seconds/note (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ws_fill_once ON work_sessions;
--> statement-breakpoint
CREATE TRIGGER ws_fill_once BEFORE UPDATE ON work_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_ws_fill_once();
--> statement-breakpoint

/* ---------------- automation_runs: no delete; identity immutable ---------------- */
DROP TRIGGER IF EXISTS ar_no_delete ON automation_runs;
--> statement-breakpoint
CREATE TRIGGER ar_no_delete BEFORE DELETE ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_reject('automation_runs is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_ar_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
    OR NEW.automation_id IS DISTINCT FROM OLD.automation_id OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.depth IS DISTINCT FROM OLD.depth OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.rowid IS DISTINCT FROM OLD.rowid
    OR (OLD.finished_at IS NOT NULL AND (NEW.finished_at IS DISTINCT FROM OLD.finished_at OR NEW.status IS DISTINCT FROM OLD.status))
  THEN
    RAISE EXCEPTION 'automation run identity is immutable; finished runs cannot change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ar_guard ON automation_runs;
--> statement-breakpoint
CREATE TRIGGER ar_guard BEFORE UPDATE ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_ar_guard();
--> statement-breakpoint

/* ---------------- notifications: no delete; only read_at may change ---------------- */
DROP TRIGGER IF EXISTS nt_no_delete ON notifications;
--> statement-breakpoint
CREATE TRIGGER nt_no_delete BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION guard_reject('notifications is append-only');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_nt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.activity_event_id IS DISTINCT FROM OLD.activity_event_id OR NEW.link_path IS DISTINCT FROM OLD.link_path
    OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'only notifications.read_at may change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nt_guard ON notifications;
--> statement-breakpoint
CREATE TRIGGER nt_guard BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION guard_nt_guard();
--> statement-breakpoint

/* ---------------- team_memberships: no delete; left_at fill-once ---------------- */
DROP TRIGGER IF EXISTS tm_no_delete ON team_memberships;
--> statement-breakpoint
CREATE TRIGGER tm_no_delete BEFORE DELETE ON team_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_reject('team_memberships is append-only (set left_at)');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_tm_fill_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
    OR NEW.added_by_user_id IS DISTINCT FROM OLD.added_by_user_id
  THEN
    RAISE EXCEPTION 'membership rows are immutable except left_at/removed_by (fill-once)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tm_fill_once ON team_memberships;
--> statement-breakpoint
CREATE TRIGGER tm_fill_once BEFORE UPDATE ON team_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_tm_fill_once();
--> statement-breakpoint

/* ---------------- jobs / users: never hard-deleted ---------------- */
DROP TRIGGER IF EXISTS jobs_no_delete ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_no_delete BEFORE DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_reject('jobs cannot be deleted; cancel instead');
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_no_delete ON users;
--> statement-breakpoint
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_reject('users cannot be deleted; deactivate or anonymise instead');
--> statement-breakpoint

/* ---------------- jobs consistency ---------------- */
CREATE OR REPLACE FUNCTION guard_jobs_status_in_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT ws.workflow_id FROM workflow_statuses ws WHERE ws.id = NEW.status_id) IS DISTINCT FROM NEW.workflow_id
    OR (SELECT ws.category FROM workflow_statuses ws WHERE ws.id = NEW.status_id) IS DISTINCT FROM NEW.status_category
  THEN
    RAISE EXCEPTION 'jobs.status_id must belong to jobs.workflow_id and status_category must match the status';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_status_in_workflow_ins ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_status_in_workflow_ins BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_status_in_workflow();
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_status_in_workflow_upd ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_status_in_workflow_upd BEFORE UPDATE OF status_id, workflow_id, status_category ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_status_in_workflow();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jobs_client_matches_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT p.client_id FROM projects p WHERE p.id = NEW.project_id) IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'jobs.client_id must equal projects.client_id of jobs.project_id';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_client_matches_project_ins ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_client_matches_project_ins BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_client_matches_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_client_matches_project_upd ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_client_matches_project_upd BEFORE UPDATE OF client_id, project_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_client_matches_project();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jobs_status_change_needs_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status_id IS DISTINCT FROM OLD.status_id
    AND NOT EXISTS (
      SELECT 1 FROM job_status_transitions t
      WHERE t.job_id = NEW.id AND t.to_status_id = NEW.status_id AND t.exited_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'jobs.status_id can only change after its open job_status_transitions row exists (use transitionJobStatus)';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_status_change_needs_transition ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_status_change_needs_transition BEFORE UPDATE OF status_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_status_change_needs_transition();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_jobs_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.job_number IS DISTINCT FROM OLD.job_number
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'jobs.organisation_id / job_number / created_by / created_at are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_org_immutable ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_org_immutable BEFORE UPDATE OF organisation_id, job_number, created_by_user_id, created_at ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_jobs_org_immutable();
--> statement-breakpoint

/* ---------------- (Postgres only) no TRUNCATE of guarded tables ---------------- */
DROP TRIGGER IF EXISTS ae_no_truncate ON activity_events;
--> statement-breakpoint
CREATE TRIGGER ae_no_truncate BEFORE TRUNCATE ON activity_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('activity_events is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS jst_no_truncate ON job_status_transitions;
--> statement-breakpoint
CREATE TRIGGER jst_no_truncate BEFORE TRUNCATE ON job_status_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('job_status_transitions is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS ja_no_truncate ON job_assignments;
--> statement-breakpoint
CREATE TRIGGER ja_no_truncate BEFORE TRUNCATE ON job_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('job_assignments is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS jr_no_truncate ON job_revisions;
--> statement-breakpoint
CREATE TRIGGER jr_no_truncate BEFORE TRUNCATE ON job_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('job_revisions is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS jl_no_truncate ON job_links;
--> statement-breakpoint
CREATE TRIGGER jl_no_truncate BEFORE TRUNCATE ON job_links
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('job_links is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS jc_no_truncate ON job_comments;
--> statement-breakpoint
CREATE TRIGGER jc_no_truncate BEFORE TRUNCATE ON job_comments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('job_comments are permanent (soft-delete only)');
--> statement-breakpoint
DROP TRIGGER IF EXISTS ws_no_truncate ON work_sessions;
--> statement-breakpoint
CREATE TRIGGER ws_no_truncate BEFORE TRUNCATE ON work_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('work_sessions is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS ar_no_truncate ON automation_runs;
--> statement-breakpoint
CREATE TRIGGER ar_no_truncate BEFORE TRUNCATE ON automation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('automation_runs is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS nt_no_truncate ON notifications;
--> statement-breakpoint
CREATE TRIGGER nt_no_truncate BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('notifications is append-only');
--> statement-breakpoint
DROP TRIGGER IF EXISTS tm_no_truncate ON team_memberships;
--> statement-breakpoint
CREATE TRIGGER tm_no_truncate BEFORE TRUNCATE ON team_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('team_memberships is append-only (set left_at)');
--> statement-breakpoint
DROP TRIGGER IF EXISTS jobs_no_truncate ON jobs;
--> statement-breakpoint
CREATE TRIGGER jobs_no_truncate BEFORE TRUNCATE ON jobs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('jobs cannot be deleted; cancel instead');
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_no_truncate ON users;
--> statement-breakpoint
CREATE TRIGGER users_no_truncate BEFORE TRUNCATE ON users
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reject('users cannot be deleted; deactivate or anonymise instead');
