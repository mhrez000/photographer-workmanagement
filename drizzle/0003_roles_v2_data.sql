-- Roles v2 data migration (docs/ROLES.md §1.3) — CUSTOM (`drizzle-kit generate --custom`).
-- Runs after 0002_roles_v2.sql (generated DDL: the new columns, FKs and index).
--
--   (a)  audit: one user.role_changed event per migrated owner/manager (actor NULL, cause "migration")
--   (b)  owner → photographer + admin; manager → photographer (team member) with every switch on;
--        photographers_see_all_jobs → can_view_all_jobs; editors_see_team_jobs is NOT migrated (recorded)
--   (b2) every organisation gets an active admin (ex-manager first, else the earliest photographer) or RAISE
--   (b3) organisation_settings.primary_owner_user_id = the earliest active admin
--   (b4) job_links.added_by_sharer backfill (adders who were photographers/owners/managers)
--   (c)  workflow_transitions.allowed_roles → TransitionRole[] (lossless, §5.1)
--   (d)  automation notify targets "managers" / "owner" → "admins"
--   (e)  CHECK constraints
--   (f)  3 new row-level guards: users_keep_admin, users_client_link, org_primary_owner (parsed by src/db/guard.ts)
--   (g)  guard_jl_fill_once: shared_with_client mutable only on CURRENT links; added_by_sharer immutable
--
-- Idempotent where possible (CREATE OR REPLACE FUNCTION, DROP … IF EXISTS before ADD/CREATE, NOT EXISTS
-- guards on the audit inserts). The migrator runs every pending migration in ONE transaction, so a RAISE
-- in (b2) rolls 0002 + 0003 back together: fix the data and migrate again.
--
-- Timestamps: to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') (ISO-8601 UTC like the app).
-- Ids: 'mig' || replace(gen_random_uuid()::text, '-', '') (gen_random_uuid is core since PG 13).

-- (a) audit first (reads the OLD roles)
INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                             previous_value, new_value, metadata, summary, visibility, created_at)
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''), u.organisation_id, NULL, NULL, 'user', u.id,
       'user.role_changed', 'updated',
       jsonb_build_object('role', u.role),
       jsonb_build_object('role', 'photographer', 'isAdmin', u.role = 'owner'),
       jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data', 'targetUserId', u.id,
                          'formerRole', u.role),
       CASE u.role WHEN 'owner' THEN 'Role changed from Owner to Owner / Photographer (admin)'
            ELSE 'Role changed from Manager to Photographer (team member) with every team-member switch on; manages only their own jobs' END,
       'management', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM users u WHERE u.role IN ('owner', 'manager');
--> statement-breakpoint

-- (b) roles → personas
UPDATE users SET role = 'photographer', is_admin = true, version = version + 1,
       updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE role = 'owner';
--> statement-breakpoint
UPDATE users SET role = 'photographer', is_admin = false,
       can_create_jobs = true, can_view_all_jobs = true, can_assign_editors = true,
       can_review_submissions = true, can_view_team_workloads = true, can_view_analytics = true,
       version = version + 1, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE role = 'manager';
--> statement-breakpoint
-- Existing photographers keep their flags; the new member flags take their column defaults (create ✓,
-- assign ✓, review ✓ — the v1 photographer could do all three on own jobs). Editors: can_create_jobs ✓.
-- photographers_see_all_jobs → can_view_all_jobs (same meaning: read every job):
UPDATE users u SET can_view_all_jobs = true
  FROM organisation_settings s
 WHERE s.organisation_id = u.organisation_id AND u.role = 'photographer' AND NOT u.is_admin
   AND s.photographers_see_all_jobs;
--> statement-breakpoint
-- editors_see_team_jobs is NOT migrated (v1 = teammates' jobs; v2 can_view_team_jobs = every job held by an
-- editor — migrating would widen access). Record who had it, one event per org (§1.5 notice reads it).
INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                             previous_value, new_value, metadata, summary, visibility, created_at)
SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''), s.organisation_id, NULL, NULL, 'settings', s.organisation_id,
       'settings.updated', 'updated',
       jsonb_build_object('editorsSeeTeamJobs', true), jsonb_build_object('editorsSeeTeamJobs', null),
       jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data',
         'editorIds', (SELECT coalesce(jsonb_agg(e.id ORDER BY e.id), '[]'::jsonb) FROM users e
                        WHERE e.organisation_id = s.organisation_id AND e.role = 'editor' AND e.is_active)),
       'Editors no longer see their teammates'' jobs automatically; turn on "See other editors'' jobs" per editor',
       'management', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM organisation_settings s
WHERE s.editors_see_team_jobs
  AND NOT EXISTS (SELECT 1 FROM activity_events x WHERE x.organisation_id = s.organisation_id
                    AND x.event_type = 'settings.updated' AND x.metadata->>'migration' = '0003_roles_v2_data');
--> statement-breakpoint
-- photographers_see_team_jobs / editors_see_team_workloads have no successor (§2.3).

-- (b2) every org needs an active admin. Promote the earliest active ex-manager, else the earliest active photographer.
WITH orphan AS (
  SELECT o.id AS org_id FROM organisations o
   WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.organisation_id = o.id AND a.role = 'photographer'
                       AND a.is_admin AND a.is_active)),
pick AS (
  SELECT DISTINCT ON (u.organisation_id) u.organisation_id, u.id
    FROM users u JOIN orphan ON orphan.org_id = u.organisation_id
   WHERE u.role = 'photographer' AND u.is_active
   ORDER BY u.organisation_id,
            (EXISTS (SELECT 1 FROM activity_events ae WHERE ae.entity_id = u.id AND ae.event_type = 'user.role_changed'
                      AND ae.metadata->>'migration' = '0003_roles_v2_data' AND ae.metadata->>'formerRole' = 'manager')) DESC,
            u.created_at, u.id),
ev AS (
  INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                               previous_value, new_value, metadata, summary, visibility, created_at)
  SELECT 'mig' || replace(gen_random_uuid()::text, '-', ''), p.organisation_id, NULL, NULL, 'user', p.id,
         'user.admin_changed', 'updated',
         jsonb_build_object('isAdmin', false), jsonb_build_object('isAdmin', true),
         jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data', 'targetUserId', p.id,
                            'reason', 'no_active_owner'),
         'Made an admin because the organisation had no active owner', 'management',
         to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM pick p RETURNING entity_id)
UPDATE users SET is_admin = true, version = version + 1,
       updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE id IN (SELECT entity_id FROM ev);
--> statement-breakpoint
DO $$ DECLARE bad text; BEGIN
  SELECT string_agg(o.id, ', ' ORDER BY o.id) INTO bad FROM organisations o
   WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.organisation_id = o.id AND a.role = 'photographer'
                       AND a.is_admin AND a.is_active);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles v2: organisation(s) % have no active photographer to make admin; reactivate one first', bad;
  END IF;
END $$;
--> statement-breakpoint

-- (b3) primary owner: the earliest-created active admin per org.
UPDATE organisation_settings s SET primary_owner_user_id = (
  SELECT u.id FROM users u WHERE u.organisation_id = s.organisation_id AND u.role = 'photographer'
     AND u.is_admin AND u.is_active ORDER BY u.created_at, u.id LIMIT 1)
 WHERE s.primary_owner_user_id IS NULL;
--> statement-breakpoint

-- (b4) legacy links: every v1 adder who was a photographer/owner/manager could share under v2 defaults;
--      editors could not. (Runs before (g) makes the column immutable.)
UPDATE job_links l SET added_by_sharer = true
  FROM users u WHERE u.id = l.added_by_user_id AND u.role = 'photographer' AND NOT l.added_by_sharer;
--> statement-breakpoint

-- (c) workflow edges: lossless mapping (§5.1)
UPDATE workflow_transitions SET allowed_roles = (
  SELECT jsonb_agg(r ORDER BY r) FROM (
    SELECT 'photographer' AS r WHERE allowed_roles ? 'photographer'
    UNION ALL SELECT 'admin' WHERE NOT allowed_roles ? 'photographer'
                               AND (allowed_roles ? 'owner' OR allowed_roles ? 'manager')
    UNION ALL SELECT 'editor' WHERE allowed_roles ? 'editor') x)
 WHERE allowed_roles ?| array['owner', 'manager'];
--> statement-breakpoint

-- (d) automation notify targets. AND does not short-circuit in Postgres: guard the set-returning call with CASE.
UPDATE automations SET actions = (
  SELECT jsonb_agg(CASE WHEN a->>'type' = 'notify' AND a->>'target' IN ('managers', 'owner')
                        THEN jsonb_set(a, '{target}', '"admins"') ELSE a END ORDER BY ord)
    FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(a, ord))
 WHERE CASE WHEN jsonb_typeof(actions) = 'array'
            THEN EXISTS (SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'target' IN ('managers', 'owner'))
            ELSE false END;
--> statement-breakpoint

-- (e) constraints (after the data is valid)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_ck;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('photographer', 'editor', 'client'));
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_photographer_ck;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_admin_photographer_ck CHECK (NOT is_admin OR role = 'photographer');
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_client_id_ck;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_client_id_ck CHECK ((role = 'client') = (client_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_created_by_role_ck;
--> statement-breakpoint
ALTER TABLE jobs ADD CONSTRAINT jobs_created_by_role_ck CHECK (created_by_role IN ('photographer', 'editor'));
--> statement-breakpoint

/* ---------------- (f) users / organisation_settings guards (roles v2) ---------------- */
CREATE OR REPLACE FUNCTION guard_users_keep_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_admin AND OLD.is_active AND OLD.role = 'photographer'
     AND NOT (NEW.is_admin AND NEW.is_active AND NEW.role = 'photographer') THEN
    -- Serialise demotions per organisation. FOR NO KEY UPDATE (not FOR UPDATE): it conflicts with itself, so two
    -- concurrent demotions cannot both pass, but NOT with the FOR KEY SHARE every FK insert into an
    -- org-referencing table takes (jobs, activity_events, …), so ordinary writes are never blocked.
    PERFORM 1 FROM organisations WHERE id = OLD.organisation_id FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM organisation_settings WHERE organisation_id = OLD.organisation_id
                 AND primary_owner_user_id = OLD.id) THEN
      RAISE EXCEPTION 'the primary owner must stay an active admin; transfer primary ownership first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE organisation_id = OLD.organisation_id AND id <> OLD.id
                     AND is_admin AND is_active AND role = 'photographer') THEN
      RAISE EXCEPTION 'an organisation must keep at least one active admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_keep_admin ON users;
--> statement-breakpoint
CREATE TRIGGER users_keep_admin BEFORE UPDATE OF is_admin, is_active, role ON users
  FOR EACH ROW EXECUTE FUNCTION guard_users_keep_admin();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_users_client_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'a client user cannot be moved to another client';
  END IF;
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM clients WHERE id = NEW.client_id AND organisation_id = NEW.organisation_id) THEN
    RAISE EXCEPTION 'client users must belong to a client of their organisation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_client_link ON users;
--> statement-breakpoint
CREATE TRIGGER users_client_link BEFORE INSERT OR UPDATE OF client_id, organisation_id ON users
  FOR EACH ROW EXECUTE FUNCTION guard_users_client_link();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_org_primary_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.primary_owner_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM users WHERE id = NEW.primary_owner_user_id AND organisation_id = NEW.organisation_id
         AND role = 'photographer' AND is_admin AND is_active) THEN
    RAISE EXCEPTION 'the primary owner must be an active admin of the organisation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.primary_owner_user_id IS NOT NULL AND NEW.primary_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'the primary owner cannot be cleared';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS org_primary_owner ON organisation_settings;
--> statement-breakpoint
CREATE TRIGGER org_primary_owner BEFORE INSERT OR UPDATE OF primary_owner_user_id ON organisation_settings
  FOR EACH ROW EXECUTE FUNCTION guard_org_primary_owner();
--> statement-breakpoint

/* ---------------- (g) job_links: shared_with_client mutable only on a CURRENT row; added_by_sharer immutable ---------------- */
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
    OR NEW.added_by_sharer IS DISTINCT FROM OLD.added_by_sharer
    OR (NEW.shared_with_client IS DISTINCT FROM OLD.shared_with_client
        AND (OLD.superseded_at IS NOT NULL OR OLD.removed_at IS NOT NULL))
  THEN
    RAISE EXCEPTION 'link rows are immutable; replace by superseding or remove once';
  END IF;
  RETURN NEW;
END;
$$;
