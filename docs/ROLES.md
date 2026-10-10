# Roles & permissions v2 — the contract (branch `feat/roles-v2`)

**Status: implementation-ready contract (revision 2, after the security and product reviews).** Every agent implementing roles v2 works from this file. Where it disagrees with `docs/ARCHITECTURE.md` §3 / §4.2 / §6 / §10 / §12, **this file wins** until the foundation agent rewrites those sections to point here (same PR). If you find a flaw, fix it HERE in the same change and say so in your report. The "Review log" at the end records what changed in revision 2 and what was rejected.

Rules that do not change: everything async (`docs/POSTGRES-MIGRATION.md`); every mutation + its audit event in ONE transaction; audit log append-only; no hard deletes; org isolation (foreign ids → 404); optimistic `version`; no `any`, no `console.log`; never touch Supabase / `.env.supabase` (local PGlite only); tests are ported, never weakened.

**§16 lists the decisions the user must confirm before `0003` runs against production data.** The contract states a default for each; implementation proceeds on the defaults.

---

## 0. The model in one screen

```
Organisation
├── Owner / Photographer   role = photographer, is_admin = true    (≥ 1 per org; exactly one is the PRIMARY owner)
├── Photographers          role = photographer, is_admin = false   ("team members", 6 permission switches)
├── Editors                role = editor                           (2 switches: create jobs, see other editors' jobs)
└── Clients (optional)     role = client, client_id = <client>     (portal only, per-client switch)
```

- **Exactly three roles**: `ROLES = ["photographer", "editor", "client"]`. There is no owner or manager role any more.
- **Admin is a property of a photographer** (`users.is_admin`), not a role. The person who runs the business is a photographer who is an admin, so their own shoots are ordinary jobs and they never switch accounts or roles.
- **Primary owner** (`organisation_settings.primary_owner_user_id`): the one admin other admins cannot demote, deactivate, re-role, re-email or reset (§3.4). Only the primary owner can hand that status to another admin. This keeps "the owner is the only role with full administrative control by default": co-owners exist only when the owner grants admin, and they cannot take over.
- **Persona** = what the UI and the policy key on. Derived, never stored:

| Persona key | Rule | Display label (`personaLabel`) |
|---|---|---|
| `admin` | `role = photographer ∧ is_admin` (also the system context) | **Owner / Photographer** |
| `member` | `role = photographer ∧ ¬is_admin` | **Photographer (team member)** |
| `editor` | `role = editor` | **Editor** |
| `client` | `role = client` | **Client** |

- **All staff can create jobs by default** (admin always; members and editors while their `can_create_jobs` switch is on, default on). Clients never (§16 Q1).
- **Personal vs business view**: admins (and members with `can_view_all_jobs`) get a topbar switch **My shoots | Whole business** (§8). "My shoots" = jobs where I am the photographer.
- **Clients** use a separate portal (`/portal`, `/api/portal/*`) and never reach a staff page or staff API (§7).

---

## 1. Data model changes

### 1.1 Constants (`src/lib/constants.ts`)

```ts
export const ROLES = ["photographer", "editor", "client"] as const;          // users.role
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES = ["photographer", "editor"] as const;              // roles that use the app shell
export type StaffRole = (typeof STAFF_ROLES)[number];
export const PERSONAS = ["admin", "member", "editor", "client"] as const;
export type Persona = (typeof PERSONAS)[number];
export const PERSONA_LABELS: Record<Persona, string> = {
  admin: "Owner / Photographer", member: "Photographer (team member)", editor: "Editor", client: "Client",
};
/** Values allowed in workflow_transitions.allowed_roles (§5). "photographer" includes admins. */
export const TRANSITION_ROLES = ["admin", "photographer", "editor"] as const;
export type TransitionRole = (typeof TRANSITION_ROLES)[number];
export const TRANSITION_ROLE_LABELS: Record<TransitionRole, string> = {
  admin: "Owner / admins (on any job)",
  photographer: "Photographers (admins, and team members on jobs they manage)",
  editor: "Editor (the assigned editor)",
};
/** Categories after which the editor's work is frozen and only reviewers act (§3.3 †, §5.2). */
export const REVIEW_GATED_CATEGORIES = [...CATEGORY_GROUPS.REVIEWER_HOLDS, "approved", "delivered", "completed"] as const;
```

- **Removed**: `MANAGEMENT_ROLES`, `ROLE_LABELS` (replace with `PERSONA_LABELS` / `personaLabel`), `roleMayEver` (replaced by `personaMayEver`, §3.1). `ASSIGNMENT_ROLES` stays `["photographer", "editor"]`.
- `NOTE_KINDS` += `"delivery"` → `["photographer", "editor", "internal", "revision", "client", "delivery"]`. `NOTE_KIND_META` gains `clientVisible` and `editorReadable`: `delivery = { label: "Delivery notes (visible to the client)", managementOnly: false, clientVisible: true, editorReadable: true }`; `internal` and `client` have `editorReadable: false` (§2.4); every kind except `delivery` has `clientVisible: false`. The existing `"client"` kind is unchanged in meaning: internal notes ABOUT the client, never shown to the client, never shown to editors.
- `AUTOMATION_NOTE_KINDS = NOTE_KINDS without "delivery"` — automations can never publish client-visible text (§6.3).
- `COMMENT_KINDS` += `"client_feedback"`. `STAFF_COMMENT_KINDS = ["comment", "question", "clarification_request", "revision_response"]`. `QUESTION_COMMENT_KINDS = ["question", "clarification_request"]` (§6.4).
- `EVENT_TYPES` += `"job.client_sharing_changed"`, `"project.client_sharing_changed"`, `"link.client_sharing_changed"`, `"client.portal_updated"`, `"user.admin_changed"`, `"settings.primary_owner_changed"`. (`user.*` and `settings.*` are already management prefixes.)
- `EVENT_CAUSES` += `"migration"`. Sharing events carry the business reason separately in `metadata.reason` ∈ `SHARING_REASONS = ["manual", "delivered", "client_changed", "project_client_changed"]` (cause stays the actor cause: user / automation / …).
- `NOTIFICATION_TYPES` += `"client_feedback"` (staff), `"client_work_shared"`, `"client_work_delivered"`, `"client_feedback_reply"` (clients). New `CLIENT_NOTIFICATION_TYPES = ["client_work_shared", "client_work_delivered", "client_feedback_reply"] as const`. Meta: all four `mandatory: false`; labels "Client left feedback", "Work shared with you", "Your work is ready", "The studio replied". Also `"job_created"` (staff, `mandatory: false`, "Editor created a job that needs an editor") for the §4.3 unassigned editor-created job notice (added by package B; the contract named the notice but not the type).
- `DASHBOARD_WIDGET_TYPES` += `"my_shoots"`, `"awaiting_review"`, `"revisions"`, `"upcoming_deadlines"`, `"questions"`, `"turnaround"` (§9).
- `CLIENT_MILESTONES = ["booked", "shot", "editing", "delivered"] as const` + `CLIENT_MILESTONE_LABELS` (§7.4).
- `MEMBER_FLAGS` / `MEMBER_FLAG_META` and `EDITOR_FLAGS` / `EDITOR_FLAG_META` (§2.2) — label, plain-English description, invite default, migrated default, column.
- `VIEW_SCOPES = ["mine", "business"] as const`, `VIEW_SCOPE_COOKIE = "pwm_scope"` (§8).
- `PERMISSIONS` becomes `Record<string, readonly Persona[]>` (§3).
- `DEFAULT_WORKFLOW_TRANSITIONS`: every `OMP` → `["photographer"]`, every `OME` → `["admin", "editor"]`, the decline/unassign edge `assigned → ready` → `["photographer", "editor"]`. `DefaultTransitionDef.allowedRoles: readonly TransitionRole[]`. Generated cancel edges (`generateCancelEdges`, seed, `insertDefaultWorkflow`) → `["photographer"]`. (Edge roles are only the first gate; §5.2 step 6 applies the action rules, so `["photographer"]` on an unassign edge does NOT let a member without ⚑assign unassign.)
- `PORTAL_CANCELLED_VISIBLE_DAYS = 30` (§7.2).

### 1.2 Schema (`src/db/schema.ts`)

| Table | Column | Type / default | Notes |
|---|---|---|---|
| `users` | `is_admin` | `boolean not null default false` | only for `role = photographer` (CHECK) |
| `users` | `can_create_jobs` | `boolean not null default true` | member AND editor flag (§2.2) |
| `users` | `can_view_all_jobs` | `boolean not null default false` | member flag |
| `users` | `can_assign_editors` | `boolean not null default true` | member flag |
| `users` | `can_review_submissions` | `boolean not null default true` | member flag. DDL default `true` so existing photographers keep v1 behaviour; **new invites default to `false`** (§6.1) |
| `users` | `can_view_team_workloads` | exists, default false | member flag (no longer read for editors) |
| `users` | `can_view_analytics` | exists, default false | member flag |
| `users` | `can_view_team_jobs` | `boolean not null default false` | editor flag |
| `users` | `client_id` | `text null references clients(id) on delete restrict` | required iff `role = client` (CHECK); immutable once set (trigger, §1.3 f); index `users_org_client_idx (organisation_id, client_id)` |
| `organisation_settings` | `primary_owner_user_id` | `text null references users(id) on delete restrict` | backfilled by 0003; `db:verify` requires non-null + active admin (§1.4); trigger-guarded (§1.3 f) |
| `organisation_settings` | `default_photographer_user_id` | `text null references users(id) on delete restrict` | photographer pre-filled for jobs editors create; null = primary owner (§4.3) |
| `organisation_settings` | `roles_v2_notice_dismissed_at` | `text null` | post-migration notice on /settings/users (§1.5) |
| `clients` | `portal_enabled` | `boolean not null default false` | client users can sign in only while true |
| `clients` | `feedback_enabled` | `boolean not null default false` | client users may post feedback only while true |
| `projects` | `shared_with_client` | `boolean not null default false` | shares every job of the project (current and future) |
| `jobs` | `shared_with_client` | `boolean not null default false` | shares this job |
| `jobs` | `created_by_role` | `text not null default 'photographer'` | role of the creator AT CREATION (`photographer` \| `editor`); never updated; CHECK in 0003. Default is correct for every legacy row (v1 editors could not create jobs) |
| `job_links` | `shared_with_client` | `boolean not null default false` | explicit share of one link (§7.3) |
| `job_links` | `added_by_sharer` | `boolean not null default false` | `true` when the adder could `link.share_with_client` on the job at insert time (system context → true). Immutable (guard, §1.3 g). Drives the default share set of a non-dialog delivery (§7.3) |

`users.role` stays `text` with the TS enum (no Postgres enum; values enforced by the CHECK in §1.3). `workflow_transitions.allowed_roles` becomes `jsonb().$type<TransitionRole[]>()`.

`AutomationAction` notify target: `"managers" | "owner"` → **`"admins"`** (`"photographer" | "editor" | "previous_editor" | "creator" | "admins" | "user"`). `src/lib/validation/json.ts` WRITE schema accepts only the new set; the READ (parse-or-fallback) schema also accepts legacy `"managers"` / `"owner"` and normalises both to `"admins"` (old `automation_runs.actions_performed` snapshots are frozen ledger rows and still contain them).

**Deprecated (kept physically, no longer read)**: `organisation_settings.photographers_see_all_jobs`, `photographers_see_team_jobs`, `editors_see_team_jobs`, `editors_see_team_workloads`. Keep the four columns in `schema.ts` with `/** @deprecated roles-v2: replaced by per-user flags; unused; drop in a later migration */` so drizzle-kit generates no DROP. Remove them from `ContextSettings`, `settingsToContext`, the settings Zod schema (unknown keys → 400 like any other unknown field), `organisation-form.tsx`, and every reader. **Why**: visibility is now per person (§2), and dropping columns is irreversible.

### 1.3 Migrations

Two files, applied in order by every migrate (PGlite auto-migrate, `makeTestDb()`, `db:migrate`, `db:migrate:remote`):

1. **`drizzle/0002_roles_v2.sql`** — GENERATED: change `schema.ts` (§1.2), then `npx drizzle-kit generate --name roles_v2`. Contains only `ADD COLUMN … DEFAULT …`, the FKs and the index. Do not hand-edit it.
2. **`drizzle/0003_roles_v2_data.sql`** — CUSTOM: `npx drizzle-kit generate --custom --name roles_v2_data`, then write the SQL below. Statements separated by `--> statement-breakpoint`. Idempotent where possible (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`).

> Deviation from the brief ("SQL migration 0002"): the DDL must be drizzle-generated (the freshness test in `src/db/test-db.test.ts` compares the last snapshot with `schema.ts`), while data rewrites, CHECKs that would fail on legacy rows, and triggers must be a custom migration (POSTGRES-MIGRATION.md §6). Hence 0002 (DDL) + 0003 (data + constraints + triggers).

`0003_roles_v2_data.sql`, in this order. `NOW_ISO` below stands for `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`; `NEW_ID` for `'mig' || replace(gen_random_uuid()::text, '-', '')` (gen_random_uuid is core in PG 13+; PGlite = PG 17). Write them out in full in the file.

```sql
-- (a) audit first (reads OLD roles): one user.role_changed event per migrated owner/manager,
--     actor NULL, cause "migration", visibility management. Summaries are accurate and actor-less.
INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                             previous_value, new_value, metadata, summary, visibility, created_at)
SELECT NEW_ID, u.organisation_id, NULL, NULL, 'user', u.id,
       'user.role_changed', 'updated',
       jsonb_build_object('role', u.role),
       jsonb_build_object('role', 'photographer', 'isAdmin', u.role = 'owner'),
       jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data', 'targetUserId', u.id,
                          'formerRole', u.role),
       CASE u.role WHEN 'owner' THEN 'Role changed from Owner to Owner / Photographer (admin)'
            ELSE 'Role changed from Manager to Photographer (team member) with every team-member switch on; manages only their own jobs' END,
       'management', NOW_ISO
FROM users u WHERE u.role IN ('owner', 'manager');

-- (b) roles → personas
UPDATE users SET role = 'photographer', is_admin = true, version = version + 1, updated_at = NOW_ISO
 WHERE role = 'owner';
UPDATE users SET role = 'photographer', is_admin = false,
       can_create_jobs = true, can_view_all_jobs = true, can_assign_editors = true,
       can_review_submissions = true, can_view_team_workloads = true, can_view_analytics = true,
       version = version + 1, updated_at = NOW_ISO
 WHERE role = 'manager';
-- existing photographers keep their flags; the new member flags take their column defaults
-- (create ✓, assign ✓, review ✓ — the v1 photographer could already do all three on own jobs).
-- Existing editors: can_create_jobs takes its default (✓).
-- photographers_see_all_jobs → can_view_all_jobs (same meaning: read every job):
UPDATE users u SET can_view_all_jobs = true
  FROM organisation_settings s
 WHERE s.organisation_id = u.organisation_id AND u.role = 'photographer' AND NOT u.is_admin
   AND s.photographers_see_all_jobs;
-- editors_see_team_jobs is NOT migrated: v1 meant "my teammates' jobs", v2's can_view_team_jobs means
-- "every job held by any editor". Migrating it would widen access. Instead record who had it (one event per org):
INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                             previous_value, new_value, metadata, summary, visibility, created_at)
SELECT NEW_ID, s.organisation_id, NULL, NULL, 'settings', s.organisation_id, 'settings.updated', 'updated',
       jsonb_build_object('editorsSeeTeamJobs', true), jsonb_build_object('editorsSeeTeamJobs', null),
       jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data',
         'editorIds', (SELECT coalesce(jsonb_agg(e.id ORDER BY e.id), '[]'::jsonb) FROM users e
                        WHERE e.organisation_id = s.organisation_id AND e.role = 'editor' AND e.is_active)),
       'Editors no longer see their teammates'' jobs automatically; turn on "See other editors'' jobs" per editor',
       'management', NOW_ISO
FROM organisation_settings s WHERE s.editors_see_team_jobs;
-- photographers_see_team_jobs / editors_see_team_workloads have no successor (§2.3).

-- (b2) every org needs an active admin. An org whose owner is inactive (managers ran it) would otherwise
--      be locked out. Promote the earliest active ex-manager, else the earliest active photographer.
WITH orphan AS (
  SELECT o.id AS org_id FROM organisations o
   WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.organisation_id = o.id AND a.role = 'photographer'
                       AND a.is_admin AND a.is_active)),
pick AS (
  SELECT DISTINCT ON (u.organisation_id) u.organisation_id, u.id
    FROM users u JOIN orphan ON orphan.org_id = u.organisation_id
   WHERE u.role = 'photographer' AND u.is_active
   ORDER BY u.organisation_id,
            (EXISTS (SELECT 1 FROM activity_events ev WHERE ev.entity_id = u.id AND ev.event_type = 'user.role_changed'
                      AND ev.metadata->>'migration' = '0003_roles_v2_data' AND ev.metadata->>'formerRole' = 'manager')) DESC,
            u.created_at, u.id),
ev AS (
  INSERT INTO activity_events (id, organisation_id, actor_user_id, job_id, entity_type, entity_id, event_type, action,
                               previous_value, new_value, metadata, summary, visibility, created_at)
  SELECT NEW_ID, p.organisation_id, NULL, NULL, 'user', p.id, 'user.admin_changed', 'updated',
         jsonb_build_object('isAdmin', false), jsonb_build_object('isAdmin', true),
         jsonb_build_object('cause', 'migration', 'migration', '0003_roles_v2_data', 'targetUserId', p.id,
                            'reason', 'no_active_owner'),
         'Made an admin because the organisation had no active owner', 'management', NOW_ISO
    FROM pick p RETURNING entity_id)
UPDATE users SET is_admin = true, version = version + 1, updated_at = NOW_ISO
 WHERE id IN (SELECT entity_id FROM ev);
DO $$ DECLARE bad text; BEGIN
  SELECT string_agg(o.id, ', ') INTO bad FROM organisations o
   WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.organisation_id = o.id AND a.role = 'photographer'
                       AND a.is_admin AND a.is_active);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'roles v2: organisation(s) % have no active photographer to make admin; reactivate one first', bad;
  END IF;
END $$;

-- (b3) primary owner + nothing else: earliest-created active admin per org.
UPDATE organisation_settings s SET primary_owner_user_id = (
  SELECT u.id FROM users u WHERE u.organisation_id = s.organisation_id AND u.role = 'photographer'
     AND u.is_admin AND u.is_active ORDER BY u.created_at, u.id LIMIT 1)
 WHERE s.primary_owner_user_id IS NULL;

-- (b4) job_links.added_by_sharer for legacy rows: every v1 adder who was a photographer/owner/manager could
--      share under v2 defaults; editors could not. (Runs before (g) makes the column immutable.)
UPDATE job_links l SET added_by_sharer = true
  FROM users u WHERE u.id = l.added_by_user_id AND u.role = 'photographer';

-- (c) workflow edges: lossless mapping (§5.1)
UPDATE workflow_transitions SET allowed_roles = (
  SELECT jsonb_agg(r ORDER BY r) FROM (
    SELECT 'photographer' AS r WHERE allowed_roles ? 'photographer'
    UNION ALL SELECT 'admin' WHERE NOT allowed_roles ? 'photographer'
                               AND (allowed_roles ? 'owner' OR allowed_roles ? 'manager')
    UNION ALL SELECT 'editor' WHERE allowed_roles ? 'editor') x)
 WHERE allowed_roles ?| array['owner', 'manager'];

-- (d) automation notify targets. AND does not short-circuit in Postgres: guard the set-returning call with CASE.
UPDATE automations SET actions = (
  SELECT jsonb_agg(CASE WHEN a->>'type' = 'notify' AND a->>'target' IN ('managers', 'owner')
                        THEN jsonb_set(a, '{target}', '"admins"') ELSE a END ORDER BY ord)
    FROM jsonb_array_elements(actions) WITH ORDINALITY AS t(a, ord))
 WHERE CASE WHEN jsonb_typeof(actions) = 'array'
            THEN EXISTS (SELECT 1 FROM jsonb_array_elements(actions) a WHERE a->>'target' IN ('managers', 'owner'))
            ELSE false END;

-- (e) constraints (after the data is valid)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_ck;
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('photographer', 'editor', 'client'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_photographer_ck;
ALTER TABLE users ADD CONSTRAINT users_admin_photographer_ck CHECK (NOT is_admin OR role = 'photographer');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_client_id_ck;
ALTER TABLE users ADD CONSTRAINT users_client_id_ck CHECK ((role = 'client') = (client_id IS NOT NULL));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_created_by_role_ck;
ALTER TABLE jobs ADD CONSTRAINT jobs_created_by_role_ck CHECK (created_by_role IN ('photographer', 'editor'));

-- (f) triggers (3 new row-level guards; names below are parsed by src/db/guard.ts)
CREATE OR REPLACE FUNCTION guard_users_keep_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_admin AND OLD.is_active AND OLD.role = 'photographer'
     AND NOT (NEW.is_admin AND NEW.is_active AND NEW.role = 'photographer') THEN
    -- Serialise demotions per organisation. FOR NO KEY UPDATE (not FOR UPDATE): it conflicts with itself, so two
    -- concurrent demotions cannot both pass, but NOT with the FOR KEY SHARE that every FK insert into an
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
END; $$;
DROP TRIGGER IF EXISTS users_keep_admin ON users;
CREATE TRIGGER users_keep_admin BEFORE UPDATE OF is_admin, is_active, role ON users
  FOR EACH ROW EXECUTE FUNCTION guard_users_keep_admin();

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
END; $$;
DROP TRIGGER IF EXISTS users_client_link ON users;
CREATE TRIGGER users_client_link BEFORE INSERT OR UPDATE OF client_id, organisation_id ON users
  FOR EACH ROW EXECUTE FUNCTION guard_users_client_link();

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
END; $$;
DROP TRIGGER IF EXISTS org_primary_owner ON organisation_settings;
CREATE TRIGGER org_primary_owner BEFORE INSERT OR UPDATE OF primary_owner_user_id ON organisation_settings
  FOR EACH ROW EXECUTE FUNCTION guard_org_primary_owner();

-- (g) job_links: content stays immutable; shared_with_client is the ONE mutable flag on a CURRENT row,
--     frozen once the row is superseded or removed; added_by_sharer is immutable. CREATE OR REPLACE the 0001
--     function guard_jl_fill_once (copy its whole body from 0001_guards.sql, same message) with two extra clauses:
--       OR NEW.added_by_sharer IS DISTINCT FROM OLD.added_by_sharer
--       OR (NEW.shared_with_client IS DISTINCT FROM OLD.shared_with_client
--           AND (OLD.superseded_at IS NOT NULL OR OLD.removed_at IS NOT NULL))
```

`src/db/guard.ts`: `GUARD_MIGRATION_FILES = ["0001_guards.sql", "0003_roles_v2_data.sql"]`; `parseGuards()` concatenates both. Row-level guard count becomes **31** (28 + `users_keep_admin` + `users_client_link` + `org_primary_owner`); update every "28" in tests, docs and `CLAUDE.md`. Error helpers: `isGuardViolation()` already covers P0001; add `isCheckViolation(err, constraint?)` (SQLSTATE 23514) to `src/db/errors.ts`.

**Session cookies survive the migration**: no `session_version` bump (contexts re-read the user row on every request, so the new role applies at once).

**Production data** (Supabase) may contain real manager accounts and orgs without an active owner. 0003 must not run remotely until the user has answered §16 Q2 and Q3. A read-only pre-check query is part of the PR description (counts of managers, orgs without an active owner, orgs with `editors_see_team_jobs`); the user runs it, never an agent.

### 1.4 `db:verify` additions (`src/db/verify.ts`, `IntegrityReport`)

- `org_has_active_admin`: every organisation has ≥ 1 user with `role = photographer ∧ is_admin ∧ is_active`.
- `org_primary_owner_valid`: every `organisation_settings.primary_owner_user_id` is non-null and an active admin of that org.
- `org_default_photographer_valid`: `default_photographer_user_id` is null or a photographer of that org (an inactive one is reported as a warning, not drift; §4.3 falls back).
- `client_user_client_in_org`: every client user's `client_id` belongs to their organisation.
- `transition_roles_valid`: every `workflow_transitions.allowed_roles` is a non-empty subset of `TRANSITION_ROLES`.
- `no_legacy_roles`: no `users.role` outside `ROLES` (belt and braces for the CHECK).
- `job_created_by_role_matches`: for jobs created after the migration, `created_by_role` equals the role in the `job.created` event's `metadata.creatorRole` (§4).

### 1.5 Post-migration notice

`/settings/users` shows admins a dismissible card while `roles_v2_notice_dismissed_at IS NULL` and the org has a `0003_roles_v2_data` migration event:
- "**N former managers are now team members.** They keep every team-member switch but manage only their own jobs. Make any of them an admin?" — one row per ex-manager (from the `user.role_changed` events with `formerRole = manager`) who is still an active non-admin, each with **Make admin** (`POST /api/users/:id/admin`, audited as usual).
- When the org had `editors_see_team_jobs` on: "Editors used to see their teammates' jobs. That switch is now per editor and covers all editors' jobs. Turn on **See other editors' jobs** for: …" (the editors from the migration event), each with a toggle (`POST /api/users/:id/permissions`).
- **Dismiss** → `POST /api/settings/roles-notice/dismiss` (admin) sets the column, event `settings.updated`.

---

## 2. Permissions per person

### 2.1 Effective context (`AuthContext`, `src/lib/types.ts`; built in `src/server/auth/session.ts`)

```ts
export interface AuthContext {
  userId: string | null;
  organisationId: string;
  role: Role;                       // system context: "photographer"
  isAdmin: boolean;                 // system context: true
  isPrimaryOwner: boolean;          // system context: false
  isActive: boolean;
  // EFFECTIVE flags — never raw columns. Admin ⇒ all six member flags true. Clients ⇒ every flag false.
  canCreateJobs: boolean;           // admin ✓; member/editor = column; client ✗
  canViewAllJobs: boolean;          // admin ✓; member = column; editor ✗
  canAssignEditors: boolean;        // admin ✓; member = column; editor ✗
  canReviewSubmissions: boolean;    // admin ✓; member = column; editor ✗
  canViewTeamWorkloads: boolean;    // admin ✓; member = column; editor ✗
  canViewAnalytics: boolean;        // admin ✓; member = column; editor ✗
  canViewTeamJobs: boolean;         // editor = column; everyone else false (admins/view-all already see all)
  clientId: string | null;          // client only
  clientFeedbackEnabled: boolean;   // client only: clients.feedback_enabled
  teamUserIds: ReadonlySet<string>; // kept (teams still group people); NOT used for visibility or Team Work any more
  settings: ContextSettings;        // minus the 4 deprecated visibility flags
  isSystem: boolean; now: () => string; requestId: string; cause?: EventCause; automationRunId?: string | null;
}
```

- `buildContextFromDb` / `resolveSession` return **null** (→ 401 / redirect to `/login?expired=1`) for a client user whose client is archived or has `portal_enabled = false` — exactly like a deactivated user.
- `systemContext()`: `role: "photographer", isAdmin: true`, all flags true, `clientId: null`.
- `Viewer` (shell) gains `isAdmin`, `isPrimaryOwner`, `persona`, `personaLabel`, `title`, `clientId`, `clientName`.

Helpers in `src/server/auth/permissions.ts` (pure):

```ts
export function personaOf(ctx): Persona;           // system → "admin"
export function isAdmin(ctx): boolean;             // ctx.isSystem || (ctx.role === "photographer" && ctx.isAdmin)
export function isStaff(ctx): boolean;             // role ∈ STAFF_ROLES
export function isClient(ctx): boolean;
/** Member created it as a photographer. */
export function ownsJob(ctx, job): boolean;        // ctx.role === "photographer" && job.createdByUserId === me && job.createdByRole === "photographer"
/** "jobs they manage": photographer of the job, or created it as a photographer. PERMISSIONS ONLY — never a view scope (§8). */
export function managesJob(ctx, job): boolean;     // ctx.role === "photographer" && (job.photographerId === me || ownsJob(ctx, job))
/** Member may steer the job: created it, or manages it and has ⚑review (§3.2 "controls"). */
export function controlsJob(ctx, job): boolean;    // isAdmin(ctx) || ownsJob(ctx, job) || (managesJob(ctx, job) && ctx.canReviewSubmissions)
export function isAssignedJob(ctx, job): boolean;  // ctx.role === "editor" && job.editorId === me
export function isPastJob(ctx, job): boolean;      // ctx.role === "editor" && me ∈ job.pastEditorIds
export function isCreatedJob(ctx, job): boolean;   // ctx.role === "editor" && job.createdByUserId === me
/** Editor's creator draft window (§4.3). */
export function isEditorDraft(ctx, job): boolean;  // isCreatedJob ∧ category ∈ DRAFT_CATEGORIES ∧ job.editorId ∈ {null, me} ∧ ¬job.draftClosed
export function isTeamViewJob(ctx, job): boolean;  // ctx.role === "editor" && ctx.canViewTeamJobs && job.editorId !== null
export function hasBusinessView(ctx): boolean;     // isAdmin(ctx) || (ctx.role === "photographer" && ctx.canViewAllJobs)
/** Hard self-review rule (§3.4). */
export function workedOnJob(ctx, job): boolean;    // ctx.userId !== null && (job.editorId === me || me ∈ job.pastEditorIds)
export const DRAFT_CATEGORIES = ["new", "ready", "assigned", "accepted"] as const;
```

`JobPermissionRef` gains `createdByRole`, `sharedWithClient`, `projectSharedWithClient`, `clientId`, and **`draftClosed: boolean`**, computed by `loadJobRef` in one query:

```
draftClosed = jobs.started_at IS NOT NULL                                   -- ever started (first-start stamp, never cleared)
  OR EXISTS (job_assignments ja WHERE ja.job_id = jobs.id AND ja.role = 'editor' AND ja.unassigned_at IS NOT NULL
             AND ja.unassigned_by_user_id IS DISTINCT FROM ja.user_id)     -- an editor was removed by someone else (admin, member, system)
  OR EXISTS (job_status_transitions t WHERE t.job_id = jobs.id AND t.to_category = 'cancelled')  -- was ever cancelled
```

(The editor's own decline does not close the window.) `CommentPermissionRef` gains `kind` and `rootKind`; `LinkPermissionRef` gains `isCurrent`, `kind`, `sharedWithClient`.

**`isManagement()` is deleted.** Port rule: every call site becomes `isAdmin(ctx)` unless listed below as a visibility site (`hasBusinessView`) — **decide per call site; never widen**. Pinned ports (each has a test, §12.1):

| Call site (today) | v2 | Why |
|---|---|---|
| `queries/search.ts` L101 (internal-note search) | `internal` notes searchable by admins on any job; by members only on jobs they manage (`AND managedJobsWhere`); never editors | otherwise a ⚑all member gets an internal-note content oracle |
| `queries/search.ts` L156 (people search incl. email) | email match: `isAdmin`; rows filtered `role IN STAFF_ROLES` for non-admins | |
| `queries/users.ts` L37, L137 (full profile incl. email) | `isAdmin` ∨ self | |
| `queries/users.ts` L49 (directory `q` incl. email) | email match `isAdmin` | |
| `queries/users.ts` L64, L86 (directory emails, inactive users) | `isAdmin` | |
| `services/users.ts` L216 (email change) | `isAdmin`, never on the primary owner unless self (§3.4) | |
| `queries/clients.ts` L72, L88 (counts) | `resolveMetricScope` (§8) | visibility |
| `queries/clients.ts` L107 (`client.notes`) | admin or member (any member who can `client.view`); never editors | private information (§2.4) |
| `queries/dashboard.ts` L111, L117-130 | `resolveMetricScope` (§8) | visibility |
| `queries/teamWork.ts` L166 (`allowedPeople`) | removed; §10.1 | |
| every other `isManagement` | `isAdmin` | |

### 2.2 Permission switches

Team members (photographers without admin):

| Flag (column / ctx field) | Invite default | Migrated default | UI label | Plain-English description (shown under the checkbox) |
|---|---|---|---|---|
| — (always on) | ✓ locked | ✓ | View their own jobs | "Always on: jobs they created." |
| — (always on) | ✓ locked | ✓ | View jobs assigned to them | "Always on: jobs where they are the photographer." |
| `can_create_jobs` / `canCreateJobs` | ✓ | ✓ | Create jobs | "Can create jobs, clients and projects. They are the photographer on jobs they create." |
| `can_assign_editors` / `canAssignEditors` | ✓ | ✓ | Assign editors | "Can assign, reassign or unassign editors on their jobs." |
| `can_review_submissions` / `canReviewSubmissions` | **✗** | ✓ | Review submissions | "Can approve edits, request revisions, deliver, complete and reopen their jobs, share them with the client and reply to client feedback. Also lets them cancel or re-date jobs you assigned to them." |
| `can_view_team_workloads` / `canViewTeamWorkloads` | ✗ | ✗ (managers ✓) | View team workload | "Can see every editor's current workload and capacity." |
| `can_view_all_jobs` / `canViewAllJobs` | ✗ | per old org switch (managers ✓) | See all jobs | "Can see every job in the business, comment on it and switch to the Whole business view. They can change only their own jobs." |
| `can_view_analytics` / `canViewAnalytics` | ✗ | ✗ (managers ✓) | See analytics and reports | "Can open Insights (analytics, bottlenecks, reports, turnaround), team performance, per-person statistics and CSV exports." |

The first six rows are the spec's six team-member permissions in the spec's order (creating jobs; viewing their own jobs; viewing jobs assigned to them; assigning editors; reviewing submissions; viewing team workload); the last two are additional switches. The Roles page, invite dialog and "Your access" card render all eight rows; the two "always on" rows render as locked rows with the badge **Always on**.

Editors:

| Flag | Default | UI label | Description |
|---|---|---|---|
| `can_create_jobs` / `canCreateJobs` | ✓ | Create jobs | "Can create jobs (with a photographer) and pick up jobs they created." |
| `can_view_team_jobs` / `canViewTeamJobs` | ✗ | See other editors' jobs | "Read-only access to jobs assigned to other editors, including your own shoots that are being edited. They still can't change them or see editors' workloads." |

- **"Their jobs"** in member copy = *jobs where they are the photographer or that they created* (`managesJob`). Cancel, restore, deadline/priority and client/project changes on jobs **someone else created** additionally need *Review submissions* (`controlsJob`, §3.2).
- Admin implies every member flag; the flags of an admin are kept in the row (so revoking admin restores the previous member configuration) but ignored while `is_admin`.
- A flag outside its role is ignored. On role change (photographer ⇄ editor) the service resets the target role's flags to their **invite defaults** and audits them in the same `user.role_changed` event (`metadata.flagsReset`).
- Invite dialog summary sentence (computed from the ticked switches, updates live): "They'll be able to: create jobs, assign editors on their jobs. Reviews of their jobs come to you."

### 2.3 Visibility (`job.view`) and its SQL twin

| Persona | Sees (read) |
|---|---|
| admin | every job in the org |
| member | managed (`photographer_id = me ∨ (created_by_user_id = me ∧ created_by_role = 'photographer')`) ∨ (`canViewAllJobs` → every job) |
| editor | assigned (`editor_id = me`) ∨ past (any `job_assignments` editor row for me) ∨ created (`created_by_user_id = me`) ∨ (`canViewTeamJobs` → every job with `editor_id IS NOT NULL`) |
| client | **nothing** through staff reads; the portal uses `portalJobsWhere` (§7.2) |

- Team-based visibility (`teamUserIds`) is **retired** for job visibility. Teams still exist for grouping (settings/teams, filters).
- Editors' `team`/`past`/`created` access is **read-only**: every write rule needs `assigned` or `isEditorDraft`.
- **Editor read cut-off** (`editorReadCutoff(ctx, job)`): an editor whose only access is `past` or `created` (not `assigned`, not `teamView`) sees the job's brief (fields, dates, client name, project, job type, status) and **their own contribution**, not the next editor's work:
  - cut-off = the latest `unassigned_at` of my editor rows (past), or the `assigned_at` of the first editor assignment that is not mine (created, never held); null = no cut-off.
  - Comments, activity, notes and links are filtered to `created_at ≤ cutoff ∨ author/actor/adder = me`. The current editor is shown as "Another editor" (no name, no avatar). Time sessions of others are never shown.
  - `assigned` and `teamView` (which is the explicit permission the spec asks for) see the full job minus §2.4.
- `visibleJobsWhere(ctx)` mirrors the table exactly (inactive or `userId === null` non-system → `1 = 0`; client → `1 = 0`). `canViewJob(ctx, job)` is the pure twin; a property test asserts they agree (§12.1).

### 2.4 Private information (what editors never see)

"Editors cannot view private owner information" is defined as this list. Each item has a test (§12.1 `privacy.test.ts`).

| Private item | Editors | Members | Where enforced |
|---|---|---|---|
| Email / phone of any user (owner included) | ❌ (reduced projection) | ❌ (reduced projection) | `queries/users.ts`, search, options |
| Client contact name, email, phone; client `notes` | ❌ (name + colour only; `q` matches name only) | ✅ | `queries/clients.ts`, `getClientOptions` |
| Notes of kind `internal` and `client` | ❌ | `internal`: managed jobs only; `client`: visible jobs | `note.read` |
| Assignment `reason` text in job history | ❌ unless they are the actor or the subject of that assignment row | ✅ on visible jobs | job history query |
| Management events (`user.*`, `settings.*`, …) | ❌ | ❌ | `activity.view_management_events` |
| Other people's timers / work sessions | ❌ | managed jobs | `timer.view_others` |
| Org analytics, per-person performance, revision rates of others | ❌ (own only) | ⚑analytics | analytics/performance/directory |
| Other editors' workloads and counts | ❌ (incl. Team Work group counts, §10.1) | ⚑workloads | workloads, Team Work |
| Saved views of others (unless shared to them), dashboard layouts | ❌ | ❌ | `saved_view.*` |
| Organisation settings values (SLA hours, thresholds, automations, workflows editor) | ❌ (only what the UI needs: timezone, job number prefix, time tracking on/off) | same as editors | `settings.view` |
| Client feedback threads | read-only on jobs they can see (they may need the feedback to fix the edit) | — | `client_feedback.reply` |
| The owner's own shoots | only when assigned/past/created, or with ⚑teamJobs while an editor holds the job (that is editing work, not private) | — | §2.3 |

---

## 3. The policy

### 3.1 Shape (`src/lib/constants.ts` + `src/server/auth/permissions.ts`)

- `PERMISSIONS: { [action]: readonly Persona[] }` — personas that can EVER perform the action (a member/editor appears when a flag can enable it). `personaMayEver(persona, action)`.
- `Rule<R> = { label: string; scope: Partial<Record<Persona, string>>; memberFlag?: MemberFlag; editorFlag?: EditorFlag; allow(ctx, resource?) }`. `scope` keys must equal `PERMISSIONS[action]` (test-enforced). `memberFlag` = the flag a member needs (Roles page shows "needs: Review submissions").
- `can(ctx, action, resource)` hard rules, in order: inactive → deny; resource org ≠ ctx org → deny; `isSystem` → `SYSTEM_ACTION_ALLOWLIST` (unchanged); `userId === null` → deny; `!personaMayEver(personaOf(ctx), action)` → deny; **self-review rule** (§3.4); **primary-owner protection** (§3.4); then `rule.allow`.
- **Gate actions**: `app.access` = admin, member, editor (no resource). `portal.access` = client. `requireContext()` (all staff APIs, server actions, staff route handlers outside `/api`) does `assertCan(ctx, "app.access")` → a client gets **403** `{ code: "forbidden", message: "This area is for studio staff" }`. `requirePortalContext()` asserts `portal.access`. `requireAnyContext()` (only `/api/auth/me`, `/api/auth/logout`, `/api/auth/change-password`) skips both.
- `PermissionMatrixRow.cells: Record<Persona, { allowed: boolean; scope: string; memberFlag?: MemberFlag; editorFlag?: EditorFlag }>`.

### 3.2 Scope legend

| Key | Predicate |
|---|---|
| **any** | every resource in the org |
| **managed** | `managesJob` (photographer is me ∨ I created it as a photographer; photographers only) |
| **controls** | `controlsJob`: I created it as a photographer, or managed ∧ ⚑review |
| **assigned** | `isAssignedJob` (current editor) |
| **working** | assigned ∧ category ∈ EDITOR_HOLDS (the editor's work is not frozen) |
| **past** | editor held the job before (read-only, cut-off §2.3) |
| **created** | editor created it (read-only outside the draft window, cut-off §2.3) |
| **draft** | `isEditorDraft`: created ∧ category ∈ {new, ready, assigned, accepted} ∧ editor_id ∈ {null, me} ∧ ¬draftClosed |
| **teamView** | editor with `canViewTeamJobs` ∧ job has an editor (read-only) |
| **visible** | `canViewJob` |
| **shared** | client: `portalJobsWhere` (§7.2) |
| **self** | own row / notification / view / layout |
| ⚑flag | needs that flag (`⚑create`, `⚑all`, `⚑assign`, `⚑review`, `⚑workloads`, `⚑analytics`, `⚑teamJobs`) |

### 3.3 Matrix — every action

Legend: ✅ always · 🔸 condition · ❌ never. A = admin, M = member, E = editor, C = client. Every job-scoped cell also implies `job.view`.

| Action | A | M | E | C |
|---|---|---|---|---|
| `app.access` (new) | ✅ | ✅ | ✅ | ❌ |
| `portal.access` (new) | ❌ | ❌ | ❌ | ✅ |
| `job.create` | ✅ photographer = any active photographer (default self) | 🔸 ⚑create; photographer forced to self | 🔸 ⚑create; photographer required (default §4.3); editor = self or none | ❌ |
| `job.view` / `job.view_history` | ✅ | 🔸 managed ∨ ⚑all | 🔸 assigned ∨ past ∨ created ∨ teamView | ❌ |
| `job.edit_fields` (name, description, jobType, shootDate, estimatedHours) | ✅ | 🔸 managed | 🔸 draft | ❌ |
| `job.change_client` (new; clientId, projectId — split out of edit_fields) | ✅ ◊ | 🔸 controls ◊ | 🔸 draft ◊ | ❌ |
| `job.edit_completion_percent` | ✅ | 🔸 managed | 🔸 working | ❌ |
| `job.set_due_date` / `job.set_review_due_date` / `job.set_delivery_due_date` / `job.set_priority` | ✅ | 🔸 controls | 🔸 draft | ❌ |
| `job.assign_photographer` | ✅ | ❌ | 🔸 draft | ❌ |
| `job.assign_editor` (assign / reassign / unassign; also any workflow move that drops the editor, §5.2) | ✅ | 🔸 managed ∧ ⚑assign | ❌ | ❌ |
| `job.claim` (new: take an unassigned job I created) | ❌ | ❌ | 🔸 draft ∧ editor_id null ∧ category ∈ {new, ready} | ❌ |
| `job.bulk_reassign` | ✅ | ❌ | ❌ | ❌ |
| `job.transition` | ✅ per edge | 🔸 per edge ∧ managed | 🔸 per edge ∧ assigned (`assigneeOnly`) | ❌ |
| `job.transition_override` | ✅ | ❌ | ❌ | ❌ |
| `job.accept` / `job.start` / `job.submit` | ✅ on behalf | ❌ | 🔸 assigned | ❌ |
| `job.decline` | ❌ | ❌ | 🔸 assigned ∧ category = assigned | ❌ |
| `job.pause` (+ resume) | ✅ on behalf, EDITOR_WORKING | ❌ | 🔸 assigned ∧ EDITOR_WORKING | ❌ |
| `job.begin_review` / `revision.request` / `revision.withdraw` / `job.approve` / `job.deliver` / `job.complete` | ✅ § | 🔸 managed ∧ ⚑review § | ❌ | ❌ |
| `revision.resolve` | ✅ on behalf | ❌ | 🔸 assigned | ❌ |
| `job.cancel` | ✅ active jobs | 🔸 controls ∧ active ∧ ≠ completed | ❌ | ❌ |
| `job.reopen` | ✅ | 🔸 managed ∧ ⚑review | ❌ | ❌ |
| `job.restore` | ✅ | 🔸 controls | ❌ | ❌ |
| `job.migrate_workflow` | ✅ | ❌ | ❌ | ❌ |
| `job.share_with_client` (new) | ✅ | 🔸 managed ∧ ⚑review | ❌ | ❌ |
| `link.add` | ✅ any kind | 🔸 managed, any kind † | 🔸 (working, kinds `EDITOR_LINK_KINDS`) ∨ (draft, kinds `EDITOR_LINK_KINDS` ∪ {raw_files}) | ❌ |
| `link.replace` / `link.remove` | ✅ | 🔸 managed † | 🔸 (working ∨ draft) ∧ added by me ∧ ¬shared | ❌ |
| `link.share_with_client` (new) | ✅ current links | 🔸 managed ∧ ⚑review, current links | ❌ | ❌ |
| `note.read` | ✅ all kinds | 🔸 visible; `internal` only when managed | 🔸 visible ∧ kind ∉ {internal, client}; cut-off §2.3 | ❌ (delivery notes via portal) |
| `note.add` | ✅ all kinds | 🔸 managed; kinds photographer, client, revision; `delivery` needs ⚑review | 🔸 assigned ∨ draft; kinds editor, revision | ❌ |
| `note.edit` / `note.archive` | ✅ | 🔸 managed; same kinds as add | 🔸 assigned ∨ draft; own editor/revision notes | ❌ |
| `comment.add` / `comment.mention` (kinds `STAFF_COMMENT_KINDS`) | ✅ ‡ | 🔸 visible ‡ | 🔸 assigned ∨ draft ‡ | ❌ (portal.give_feedback) |
| `client_feedback.reply` (new) | ✅ | 🔸 managed ∧ ⚑review | ❌ (read only) | ❌ |
| `client_feedback.to_revision` (new: "Turn into revision request") | ✅ | 🔸 managed ∧ ⚑review | ❌ | ❌ |
| `comment.edit` | 🔸 own, 15 min | 🔸 own, 15 min, comment.add | 🔸 own, 15 min, comment.add | 🔸 own `client_feedback`, 15 min, `portal.give_feedback` (§7.5) |
| `comment.delete` (soft) | ✅ | 🔸 own, comment.add | 🔸 own, comment.add | 🔸 own `client_feedback`, `portal.view_job` (§7.5) |
| `timer.use` (org time tracking on) | 🔸 managed | 🔸 managed | 🔸 assigned ∧ EDITOR_WORKING | ❌ |
| `timer.view_others` | ✅ | 🔸 managed | ❌ | ❌ |
| `analytics.view` / `bottlenecks.view` / `reports.view` / `export.csv` / `performance.view` | ✅ | 🔸 ⚑analytics (job-level rows: visible jobs only, §8) | ❌ | ❌ |
| `analytics.view_self` / `workloads.view_self` | ✅ | ✅ | ✅ | ❌ |
| `workloads.view_team` | ✅ | 🔸 ⚑workloads | ❌ | ❌ |
| `team.view_members` (directories, team lists, people in search results) | ✅ | ✅ (stats §10.2) | ❌ | ❌ |
| `activity.view_global` | ✅ | 🔸 visible jobs | 🔸 visible jobs, cut-off §2.3 | ❌ |
| `activity.view_management_events` | ✅ | ❌ | ❌ | ❌ |
| `client.view` / `project.view` | ✅ | ✅ | 🔸 of visible jobs; **name/colour only** (§2.4) | ❌ |
| `client.create` | ✅ | 🔸 ⚑create | ❌ | ❌ |
| `project.create` | ✅ | 🔸 ⚑create | 🔸 ⚑create, **only inline from New job** under an existing non-archived client (§4.3) | ❌ |
| `client.edit` / `project.edit` (never the sharing/portal columns, §3.5) | ✅ | 🔸 created by self | ❌ | ❌ |
| `client.archive` / `project.archive` | ✅ | ❌ | ❌ | ❌ |
| `client.manage_portal` (new) | ✅ | ❌ | ❌ | ❌ |
| `project.share_with_client` (new) | ✅ | ❌ | ❌ | ❌ |
| `user.view` | ✅ full | 🔸 reduced projection, staff only | 🔸 reduced projection, staff only | ❌ |
| `user.invite` | ✅ any role (client: needs `clientId` of a portal-enabled client) | ❌ | ❌ | ❌ |
| `user.edit` | ✅ ¶ | 🔸 self (name, title, avatar) | 🔸 self | 🔸 self (name; portal account) |
| `user.change_email` | 🔸 self, or another non-primary-owner user ¶ | ❌ | ❌ | ❌ |
| `user.change_role` | 🔸 photographer ⇄ editor only; never self; never to/from client ¶ | ❌ | ❌ | ❌ |
| `user.deactivate` | 🔸 not self; last-admin guard ¶ | ❌ | ❌ | ❌ |
| `user.reactivate` / `user.set_capacity` | ✅ | ❌ | ❌ | ❌ |
| `user.set_permissions` (renamed from `user.set_visibility_flags`) | 🔸 target = active non-admin photographer (member flags) or editor (editor flags) | ❌ | ❌ | ❌ |
| `user.set_admin` (new) | 🔸 target = active photographer, not self; revoke subject to last-admin guard ¶ | ❌ | ❌ | ❌ |
| `user.reset_password` | ✅ (staff and client users) ¶ | 🔸 self | 🔸 self | 🔸 self |
| `user.anonymise` | 🔸 target deactivated | ❌ | ❌ | ❌ |
| `org.transfer_primary_owner` (new) | 🔸 primary owner only; target = another active admin | ❌ | ❌ | ❌ |
| `team.manage` | ✅ | ❌ | ❌ | ❌ |
| `settings.view` / `settings.manage` | ✅ | ❌ | ❌ | ❌ |
| `workflow.view` / `workflow.manage` | ✅ | ❌ | ❌ | ❌ |
| `job_type.manage` / `automation.manage` / `automation.view_runs` | ✅ | ❌ | ❌ | ❌ |
| `notification.read` / `notification.prefs` | 🔸 self | 🔸 self | 🔸 self | 🔸 self (client types only) |
| `saved_view.manage` / `dashboard.customise` | 🔸 self | 🔸 self | 🔸 self | ❌ |
| `saved_view.share` (targets: staff only) | ✅ | ❌ | ❌ | ❌ |
| `search.global` | ✅ | 🔸 visible | 🔸 visible | ❌ |
| `view.business_scope` (new: the scope switch) | ✅ | 🔸 ⚑all | ❌ | ❌ |
| `portal.view_job` (new) | ❌ | ❌ | ❌ | 🔸 shared |
| `portal.give_feedback` (new) | ❌ | ❌ | ❌ | 🔸 shared ∧ `clientFeedbackEnabled` ∧ not cancelled |
| `system.sweep` / `system.integrity` | ✅ | ❌ | ❌ | ❌ |

† **Client-facing and frozen links (members without ⚑review)**: when the job's category ∈ `REVIEW_GATED_CATEGORIES` (submitted, review, resubmitted, approved, delivered, completed), adding / replacing / removing a link of kind `gallery` or `client_delivery`, and replacing / removing any link with `shared_with_client = true`, additionally requires `link.share_with_client` on the job. **Editors** never write links once the job is in a review-gated category (their link rules require `working` or `draft`), and never replace/remove a shared link: once work is submitted it changes only through a revision.

‡ **Client threads**: a comment of kind `client_feedback` from staff must be a reply inside a `client_feedback` root and requires `client_feedback.reply`; staff cannot start a client thread (clients do, §7.5). `@mentions` are rejected (422) in `client_feedback` comments. Every other comment kind is unchanged. Members with ⚑all may comment and @mention on every visible job (comments are collaboration, not control); every other write still needs managed/controls.

◊ **Client / project change** (`applyJobFieldChanges`, §4.5): if the job is client-visible now (`jobs.shared_with_client` ∨ current project shared) **or** the target project is shared, the actor additionally needs `job.share_with_client`. A client change also un-shares the job and its links and archives its delivery notes in the same transaction.

§ **Self-review**: never allowed for anyone who edited the job (§3.4).

¶ **Primary owner**: these actions on the primary owner are denied to everyone but the primary owner (§3.4).

New resource refs: `job.claim`, `job.share_with_client`, `job.change_client`, `client_feedback.reply`, `client_feedback.to_revision` → `JobPermissionRef`; `link.share_with_client` → `LinkPermissionRef`; `project.share_with_client`, `client.manage_portal` → `OrgResourceRef`; `user.set_admin`, `user.set_permissions`, `user.change_email` → `UserPermissionRef` (+ `isPrimaryOwner`); `org.transfer_primary_owner` → `UserPermissionRef` (the target); `portal.view_job`, `portal.give_feedback` → `PortalJobRef { id, organisationId, clientId, sharedWithClient, projectSharedWithClient, statusCategory, cancelledAt }`; `app.access`, `portal.access`, `view.business_scope` → `undefined`.

### 3.4 Rules not expressible as cells

- **Assignee and target validation is allow-list only** (never `role !== "editor"`): `assign_editor` / `claim` / revision assignee → in-org, active, `role === "editor"`. `assign_photographer`, the job-create photographer and `default_photographer_user_id` → in-org, active, `role === "photographer"`. Team membership adds, mention targets, automation `assign` / notify `"user"` targets and saved-view share targets → in-org, active, `role ∈ STAFF_ROLES`. Anything else → 422. Fix both existing deny-list sites (`services/jobs.ts` createJob ~L126, `services/assignments.ts` assignPhotographer).
- **Self-review (hard rule in `can()`)**: `job.begin_review`, `job.approve`, `job.deliver`, `job.complete`, `revision.request`, `revision.withdraw`, `client_feedback.to_revision` are denied when `workedOnJob(ctx, job)` (I am or was an editor of this job), for every persona; reason "You can't review your own edit". A photographer approving an editor's work on a job they shot and created is the normal review and is allowed.
- **Primary-owner protection (hard rule in `can()`)**: `user.set_admin` (revoke), `user.change_role`, `user.deactivate`, `user.change_email`, `user.reset_password`, `user.edit` (name/title), `user.anonymise` on the primary owner → deny unless `ctx.userId === target.id` (self-service where the action allows self). The trigger (§1.3 f) blocks demotion/deactivation of the primary owner at the DB level too. `org.transfer_primary_owner`: `POST /api/organisation/primary-owner { userId, expectedVersion }` (primary owner only; target active admin) → event `settings.primary_owner_changed`. The old owner stays an admin.
- **Deactivating an admin clears admin**: `deactivateUser` on an admin sets `is_admin = false` in the same transaction and writes `user.admin_changed` (`metadata.reason = "deactivated"`) next to `user.deactivated`. Reactivation brings the person back as a team member with their stored member flags; admin is re-granted only through **Make admin**. (Last-admin and primary-owner guards apply before the deactivation.)
- **On behalf**: an admin acting on an editor-side edge writes `metadata.onBehalfOf = job.editorId` (was "owner/manager").
- **Admin guards** (service AND trigger): cannot deactivate self; cannot revoke own admin; cannot change own role; the last active admin can be neither deactivated, demoted to editor, nor have admin revoked → 422 `last_admin` ("Make another photographer an admin first"); the primary owner → 422 `primary_owner` ("Transfer primary ownership first"). The service checks first (friendly error); the trigger is the backstop (map `isGuardViolation` → the same 422).
- **Role changes**: only photographer ⇄ editor. The EXISTING integrity guards stay, unchanged in meaning: a photographer who is the photographer on open jobs cannot become an editor ("reassign them first", `services/users.ts` ~L267); an editor holding open editing jobs cannot become a photographer (~L262). Changing a photographer to editor also sets `is_admin = false` (guarded). Client ⇄ staff is impossible (422 `role_change_not_allowed`): create a new account. `session_version++` on role change (unchanged). Because `managesJob` counts creation only when `created_by_role = 'photographer'`, an ex-editor never "manages" jobs they created as an editor.
- **Mentions**: target must be active staff passing `job.view` (clients can never be mentioned).
- **Person pages** (`/team/users/[id]`, `GET /api/workloads/:userId`, `GET /api/analytics/editors/:userId`): admin; self; a member with ⚑workloads (workload detail) or ⚑analytics (performance detail) when the target is an editor; photographer targets need admin or ⚑analytics. Everyone else 403 — editors never open another person's page (`user.view` alone is no longer enough for these routes).
- **Reduced user projection** (members, editors): `id, name, title, role, isAdmin, isPrimaryOwner, avatarColour, isActive` only. Client users are excluded from every staff list, option, search and detail endpoint for non-admins: `listUsers`, `getUserOptions`, people search filter `role IN STAFF_ROLES`; the `role` filter schema is `z.enum(STAFF_ROLES)` for non-admins (admins: `z.enum(ROLES)`); `GET /api/users/:id` for a client id → **404** for non-admins. Names of client authors are still joined at read time in comments/activity (rendered with a "Client" badge).
- **User options with `jobId`** (`GET /api/users/options?jobId=`): reveals who can view a job, so the `jobId` param requires `comment.mention` on that job (editors: assigned ∨ draft; members: visible); otherwise 404 (job not visible) or 403.
- **Options for job creation** — separate option queries, never built on the list queries:
  - `GET /api/clients/options` → `getClientOptions` projecting only `{ id, name, colour }` of non-archived clients, to anyone who can `job.create`.
  - `GET /api/projects/options?clientId=` → `{ id, name, clientId }` of non-archived projects, to anyone who can `job.create`.
  - `GET /api/users/options?role=photographer` → active photographers (reduced projection with `isAdmin`, `isPrimaryOwner`, `title`) to anyone who can `job.create`.
  - `listClients` / `getClientDetail` for editors strip `contactName`, `email`, `phone`, `notes`; editors' `q` matches `name` only.

### 3.5 Sharing and portal columns are written ONLY by their dedicated services

`clients.portal_enabled`, `clients.feedback_enabled`, `projects.shared_with_client`, `jobs.shared_with_client`, `job_links.shared_with_client`, `job_links.added_by_sharer`, `users.is_admin`, `users.client_id` (after insert), `organisation_settings.primary_owner_user_id` are written only by: `setClientPortal`, `shareProject`, `shareJob`, `shareLink`, the delivery step of `applyMove` (§7.3), `applyJobFieldChanges`' client-change reset (§4.5), `updateProject`'s client-change reset, `setAdmin`, `deactivateUser`, `inviteUser`, `transferPrimaryOwner`, `addLink`/`replaceLink`/`updateLink` (insert-time `added_by_sharer` and inheritance) and the migration. Every generic input schema is **strict** (`z.strictObject`) so these keys are rejected with 400: `CreateClientInput`, `UpdateClientInput`, `CreateProjectInput`, `UpdateProjectInput`, `CreateJobInput`, `UpdateJobInput` / `JobFieldsValue`, `AddLinkInput`, `ReplaceLinkInput`, `UpdateLinkInput`, `UpdateUserInput`, `UpdateSettingsInput`. One test per schema sends each key and expects 400 and no change.

---

## 4. Job creation and management flows

### 4.1 Admin
Create form: photographer picker (all active photographers, default self; the primary owner is marked "Owner"; titles shown), editor picker (active editors or "Unassigned"), all fields, internal notes. `deliveryDueDate` is labelled **"Delivery date — visible to the client when shared"**. Everything else per §3.3.

### 4.2 Team member
- Needs `can_create_jobs`. Photographer is shown read-only as themselves; sending another `photographerId` → 403 `job.assign_photographer`.
- Editor picker only with `can_assign_editors` (else the field is hidden and `editorId` → 403 `job.assign_editor`).
- After creation they own the job (`created_by_role = photographer`, photographer = creator).

### 4.3 Editor ("All users should be able to create jobs")
- Needs `can_create_jobs` (editor switch, default on; §16 Q1 records the interpretation).
- **Photographer: required**, chosen from active photographers; the form pre-fills the **default photographer** = `organisation_settings.default_photographer_user_id` if it is an active photographer, else the primary owner. If the API omits `photographerId` for an editor, the service uses the same default. Any other role / inactive → 422. The setting lives in **Settings → Organisation → "Default photographer for jobs editors create"** (default: the primary owner) and is shown on the Roles page.
- **Client: an existing client** (options §3.4). When the client doesn't exist, the picker's empty state says "Ask your studio owner to add this client."
- **Project: existing, or "New project"** inline (name, optional address) under the chosen non-archived client → created in the same transaction by `createProject` (`project.create` E rule: `ctx.role === "editor" ∧ inlineFromJobCreate`), event `project.created` (actor = editor) before `job.created`; the editor gets no edit/archive rights on it afterwards; `shared_with_client = false`. API: `POST /api/jobs` accepts `newProject: { name, address? }` XOR `projectId`.
- **Shoot date** pre-fills with today (editors usually create after the shoot); editable.
- **Editor: "Assign to me" or "Leave unassigned"** — `editorId ∈ {undefined, null, me}`; another editor → 403 `job.assign_editor`. Self-assignment at creation is checked with `job.claim` (on the just-inserted job) and performed by `assignEditorToJob` (`reason: "Self-assigned at creation"`).
- `jobs.created_by_role = 'editor'`; `job.created` event `metadata.creatorRole = 'editor'`.
- Notifications: the photographer gets `job_assigned` ("You are the photographer on PJ-…", unchanged path). If the job is left **unassigned**, admins ∪ the photographer (if a member with ⚑assign) get `job_created` "Editor X created PJ-… and it needs an editor" (deduped against `job_assigned` for the same person: one notification, the `job_assigned` one).
- **Draft window** (`isEditorDraft`): while the job is in new/ready/assigned/accepted, held by nobody or by the creator, never started, never cancelled, and no editor was removed from it by someone else, the creator may edit fields, dates and priority, change client/project (◊), change the photographer, add links (`EDITOR_LINK_KINDS` ∪ `raw_files`), add editor/revision notes, and comment. Once they **Start**, another editor holds it, or an admin/member removes an editor, the window closes for good; they keep read access (created, cut-off §2.3).
- `POST /api/jobs/:id/claim { expectedVersion }` → `claimJob` (editor takes an unassigned job they created, later; requires the draft window, so an admin's unassign cannot be overridden).
- Editors never: assign/reassign other editors, approve/deliver/complete, cancel, set override, share with the client, see internal or client notes, approve their own work.

Worked example (the spec flow): the editor creates "14 Ocean St — twilight" with photographer = owner, project "New project: 14 Ocean St" under Harbourline, and *Assign to me*; adds the `raw_files` source link; Accepts, Starts (draft closes), adds `finished_files`, Submits (their links freeze); the owner (admin) reviews → Approve or Request revision; the editor Resubmits; the owner Delivers: the Deliver dialog (§7.3) offers to share the job and pre-selects the `finished_files` link → client notified; then Completes. Every step is an existing edge with the §5 actor checks.

### 4.4 Reviewing, delivering, reopening
Admin any job; member only managed jobs with `can_review_submissions`; nobody on a job they edited (§3.4). Members without ⚑review see the job in Review with the actions disabled and the hint "Your studio owner reviews this job".

### 4.5 Client / project changes (`applyJobFieldChanges`, `services/jobs.ts` ~L349-372)
When `projectId` (and with it `clientId`) changes:
1. `assertCan(ctx, "job.change_client", ref)`; if the job is client-visible now (`jobs.shared_with_client` ∨ current project shared) or the target project is shared → also `assertCan(ctx, "job.share_with_client", ref)`.
2. If the **client** changes, in the same transaction: `jobs.shared_with_client = false` (if it was true: `job.client_sharing_changed`, `metadata.reason = "client_changed"`); every current link with `shared_with_client = true` → false (`link.client_sharing_changed` each, same reason); every non-archived `delivery` note → archived (`note.archived`, `metadata.reason = "client_changed"`). `version++` once.
3. `toPortalJob` only includes `client_feedback` threads whose root author is a client user with `users.client_id = ctx.clientId` (old client's threads stay on the staff side only).
4. `updateProject` changing a project's client: if `projects.shared_with_client` is true it is reset to false (`project.client_sharing_changed`, `reason = "project_client_changed"`); the existing rule that a project with jobs cannot change client stays (empty projects only).

Creating a job **into** a project that is already shared is allowed for anyone who can create there: the admin's project share explicitly covers future jobs, and a new job exposes only its name, project and dates (milestone Booked/Shot); links reach the client only by an explicit share or a reviewer's delivery (§7.3). No `client_work_shared` notification for such a job.

---

## 5. Workflow edges

### 5.1 `allowed_roles` values: `TransitionRole[]`

> **Refinement of the brief** (which said "owner/manager/photographer → photographer"). That mapping has two concrete flaws: (1) editor-side edges (`OME`: accept/start/submit/resubmit) would lose the admin's on-behalf ability, because an admin is a photographer and the edge would only list `editor`; (2) custom edges that were owner/manager-only would silently open to every team member on jobs they manage. Adding the transition-role value **`admin`** keeps the mapping lossless.

| Old roles on the edge | New `allowed_roles` |
|---|---|
| contains `photographer` (OMP, OMPE) | `photographer` (+ `editor` if present) |
| no `photographer` but `owner`/`manager` (OME, OM-only) | `admin` (+ `editor` if present) |
| only `editor` | `editor` |

Validation (`validateWorkflowDefinition`, workflow editor, `workflow_transition.*` services, and `AllowedRolesSchema` in `src/lib/validation/json.ts`, which becomes `z.array(z.enum(TRANSITION_ROLES)).min(1)`): non-empty subset of `TRANSITION_ROLES`; `client` is not a value.

### 5.2 Actor check (`edgeDenialReason` in `src/lib/workflow.ts`)

1. archived edge → deny; `requiresAssignedEditor` without an active editor → "Assign an active editor first" (unchanged).
2. system context → `can(job.transition)`.
3. Role match: editor ⇐ `allowedRoles ∋ "editor"`; admin ⇐ `∋ "admin" ∨ ∋ "photographer"`; member ⇐ `∋ "photographer"`; client → never. Else "Your role cannot make this change".
4. `can(ctx, "job.transition", job)` — admin any; member managed ("Only the job's photographer or an admin can do this"); editor assigned ("Only the assigned editor can do this").
5. `assigneeOnly` ∧ editor → current editor.
6. **`actionsForMove(ctx, from, to, isReopen, job)` → `Action[]`, every action must pass `can()`** (replaces `actionForMove`, which returned one action or null):

| Move | Actions |
|---|---|
| reopen, or from completed | `job.reopen` |
| → cancelled | `job.cancel` |
| → assigned | `[]` engine-internal (assignment service) — not offered as a button |
| → new/ready from `assigned`, actor = current editor | `job.decline` |
| → new/ready while the job has an editor (any other case) | `job.assign_editor` (+ the from-gate below) |
| → new/ready without an editor | `job.transition` |
| → accepted / in_progress / submitted / resubmitted | `job.accept` / `job.start` / `job.submit` / `revision.resolve` |
| → review / revision / approved / delivered / completed | `job.begin_review` / `revision.request` / `job.approve` / `job.deliver` / `job.complete` |
| anything else | `job.transition` |
| **from-gate**: from ∈ `REVIEW_GATED_CATEGORIES` (not a reopen) | additionally `job.begin_review` (= the review permission: admin, member managed ∧ ⚑review; self-review rule applies) |

`movesFor` (UI buttons, kanban drop targets, bulk-transition preview) and `applyMove` call the same function, so the UI never offers a move the service rejects.

7. **`applyMove` (mode `"user"`)**: before `swapEditor(job, null)` on a move into `UNASSIGNED` while `job.editorId` is set, unless this is the current editor declining from `assigned`, `assertCan(ctx, "job.assign_editor", ref)` again (defence in depth for custom edges). Bulk transition (`POST /api/jobs/bulk/transition`) and kanban drops go through `applyMove`, so they are covered; tests pin both (§12.1).

On-behalf: `isAdmin(ctx) ∧ !isSystem ∧ target ∈ EDITOR_SIDE_TARGETS ∧ job.editorId ∧ job.editorId ≠ me`.

Workflow editor role chips: "Owner / admins", "Photographers", "Editor" with `TRANSITION_ROLE_LABELS` as tooltips, and the note "Each move also needs the matching permission (e.g. approving needs Review submissions)."

---

## 6. Users, admin grant, invites, notifications

### 6.1 Services (`src/server/services/users.ts`) and routes

| Route | Service | Action | Event |
|---|---|---|---|
| `POST /api/users` `{ email, name, role, title?, isAdmin?, flags?, clientId?, capacityHoursPerWeek? }` | `inviteUser` | `user.invite` (+ `user.set_admin` when `isAdmin`) | `user.created` (newValue incl. `role, isAdmin, clientId, flags`) |
| `POST /api/users/:id/role` | `changeRole` | `user.change_role` | `user.role_changed` (`metadata.flagsReset`) |
| `POST /api/users/:id/admin` `{ isAdmin, expectedVersion }` | `setAdmin` | `user.set_admin` | `user.admin_changed` |
| `POST /api/users/:id/permissions` `{ canCreateJobs?, canViewAllJobs?, canAssignEditors?, canReviewSubmissions?, canViewTeamWorkloads?, canViewAnalytics?, canViewTeamJobs?, expectedVersion }` | `setPermissions` (replaces `setVisibilityFlags`) | `user.set_permissions` | `user.flags_changed` (changed flags only) |
| `POST /api/organisation/primary-owner` `{ userId, expectedVersion }` | `transferPrimaryOwner` | `org.transfer_primary_owner` | `settings.primary_owner_changed` |
| `POST /api/users/:id/deactivate` … (unchanged, plus admin clearing §3.4) | | | |

- `/api/users/:id/visibility` is **removed** (its route file is deleted; `routes.test.ts` updated).
- Invite validation (Zod `InviteUserInput`, discriminated on `role`, strict): `photographer` → optional `isAdmin`, optional member flags (omitted flags take the **invite defaults** of §2.2: review ✗); `editor` → optional `canCreateJobs`, `canViewTeamJobs`; `client` → **required** `clientId` (in org, not archived, `portal_enabled`; else 422 "Turn on the client portal for this client first"), no flags, no capacity, no admin. Temp password returned once (unchanged).
- Email uniqueness stays **global** (`users_email_uq`; login has no organisation picker). An invite with an email in use anywhere → 409 "This email can't be used. Ask them for another address." (no org name, no role). See Review log.
- `setPermissions` on an admin target → 422 "Admins have every permission"; member flags on an editor or `canViewTeamJobs` on a photographer → 422.
- **Invite hand-off**: the invite result dialog has **Copy invite message**: "You've been invited to {studio} on Proofline. Sign in at {origin}/login with {email} and the temporary password {password}. You'll be asked to choose a new password." (Client invites use `{origin}/login` too; they land on `/portal`.) There is no email channel (§7.6).
- **Persona badge + title**: user lists, pickers and person chips show `personaLabel` and, when set, `users.title` ("Photographer (team member) · Studio manager"). The primary owner gets an "Owner" marker in Users and in the job-create photographer picker.

### 6.2 Notification recipient helpers (`services/notifications.ts`)
- `managersOf` / `ownersOf` → **`adminsOf(db, orgId)`** (active admins).
- `workloadWatchersOf(db, orgId)` = active admins ∪ active members with `can_view_team_workloads`. Used only for notifications **without job details**: `workload_threshold` (editor name + band).
- **Job-specific notifications to watchers are filtered per recipient**: `editor_unavailable` (lists job numbers/names) goes to admins, plus each member with ⚑workloads with the job list filtered by `canViewJob(recipientCtx, job)` (omitted entirely if the filtered list is empty).
- Wherever §6 of ARCHITECTURE says "managers" read **admins**; `job_reopened` adds admins when a member reopened.
- `notify()` hard filter: client users receive only `CLIENT_NOTIFICATION_TYPES`; staff never receive them; clients are skipped silently for every other type. Recipients are deduped per user per call (the owner is often photographer ∪ creator ∪ admin).

### 6.3 Automations
- `add_note` action: `kind: z.enum(AUTOMATION_NOTE_KINDS)` in the WRITE schema (`src/lib/validation/json.ts` L94); `delivery` → 400. The READ schema keeps accepting any `NOTE_KINDS` value (frozen snapshots) but `automationEngine` refuses to execute a `delivery` note action (logged as a skipped action).
- Automation `assign`/notify `"user"` targets: `role ∈ STAFF_ROLES` (§3.4).
- Org-level notification configuration stays out of scope: each person sets their own preferences (Settings → Notifications), mandatory types stay mandatory, and an owner who wants extra notifications for the business uses automations (notify admins / photographer / editor / a user).

### 6.4 Editor questions
- Comment kinds `question` and `clarification_request` notify (as `comment_added`, title "Question from {editor}"): the job's photographer, its creator if a photographer, and **all admins when neither of those can review** (member without ⚑review, inactive, or the creator is an editor). Editors are never recipients of their own question.
- A question is **open** while its thread has no reply from a staff user other than its author. Open questions appear in the `questions` widget (§9) and as a "Questions" chip on the job header.

---

## 7. Clients and the portal

### 7.1 Enabling a client
- Client record → **Client portal** card (admin, `client.manage_portal`): switches *Portal access* (`portal_enabled`) and *Allow feedback* (`feedback_enabled`) → `POST /api/clients/:id/portal { portalEnabled?, feedbackEnabled?, expectedVersion }` → event `client.portal_updated`. Turning the portal off signs its users out at their next request (context returns null; no `session_version` bump needed).
- Same card: portal users (name, email, active, last login) with **Invite client user** (name, email → temp password shown once + **Copy invite message**), deactivate / reactivate / reset password. `GET /api/clients/:id/portal-users` (admin).
- Archiving a client implicitly closes its portal (context check), without changing the flag.
- `users.client_id` is immutable (trigger): a portal user can never be moved to another client.

### 7.2 What a client can see (`portalJobsWhere(ctx)` in `permissions.ts`)

```
jobs.organisation_id = ctx.organisationId
AND jobs.client_id = ctx.clientId
AND (jobs.status_category <> 'cancelled'
     OR jobs.cancelled_at >= <now − PORTAL_CANCELLED_VISIBLE_DAYS days>)
AND (jobs.shared_with_client
     OR EXISTS (SELECT 1 FROM projects p WHERE p.id = jobs.project_id
                AND p.organisation_id = jobs.organisation_id AND p.shared_with_client))
```
Non-client context → `1 = 0`. Every portal query starts from this predicate; a job outside it is **404** (never 403). `visibleJobsWhere` returns no rows for clients, so every staff list/search/kanban/calendar is empty for them even if a guard were missed. A cancelled job stays visible for 30 days as **Cancelled** (no links, no composer), then disappears.

Sharing (audited, versioned, staff only):
- `POST /api/jobs/:id/share { shared, expectedVersion }` → `job.share_with_client` → `job.client_sharing_changed` (`reason: "manual"`).
- `POST /api/projects/:id/share { shared, expectedVersion }` → admin → `project.client_sharing_changed` (`metadata.jobCount`). Project share covers current and future jobs; unsharing the project hides jobs that are not individually shared.
- `POST /api/links/:id/share { shared }` → `link.share_with_client` (current link only; 422 otherwise) → `link.client_sharing_changed` (jobId set).

### 7.3 Client-visible links and delivery

A job's client-visible links = its **current** links (`superseded_at IS NULL ∧ removed_at IS NULL`) with `shared_with_client = true`. Nothing is auto-visible by kind; publication is always an explicit, audited act by someone who can share. Once shared, a link stays shared when the job is reopened, so the client keeps the delivered work.

**Delivery step** (inside `applyMove`, same transaction, when the job enters `delivered`, or enters `completed` with `delivered_at` null):
- `POST /api/jobs/:id/transition` (and the job header's Deliver action) accepts `delivery?: { shareJob?: boolean; shareLinkIds?: string[] }`, allowed only on a delivering move (else 422).
- `shareJob: true` → shares the job (needs `job.share_with_client`; the deliverer has it through ⚑review) → `job.client_sharing_changed` `reason: "delivered"`.
- If the job is client-visible after that: links to share = `shareLinkIds` when given (each must be a current link of this job, any kind), otherwise the **default set** = current `gallery`/`client_delivery` links with `added_by_sharer = true`. Each newly shared link → `link.client_sharing_changed` `reason: "delivered"`.
- **Deliver dialog** (UI): for a job whose client has the portal on —
  - not shared yet: checkbox **"Share this job with {client} now"** (pre-ticked when the client has the portal on);
  - link list of current links with checkboxes, pre-selected: `gallery`/`client_delivery`; if there are none, the current `finished_files` links. Each row shows URL, kind and who added it; links added after the last approval are flagged "Added after approval".
  - When a client-visible job would be delivered with no client-visible link, the dialog says "The client will see Delivered with nothing to open" and requires an explicit "Deliver without links".
- Kanban drop, bulk transition and automations deliver without the dialog → the default set applies (reviewer-added gallery/client_delivery only).

`shared_with_client` on a link is the one mutable column on the `job_links` ledger (frozen once superseded/removed by the 0003 guard). **Replacement / re-file inheritance**: `replaceLink` and `updateLink` (both create a new row) copy `shared_with_client` to the new row only when the actor may `link.share_with_client` on the job; otherwise the new row starts unshared and the event metadata carries `sharingDropped: true` (the UI then offers "Share the new link?" to someone who can). `added_by_sharer` is computed fresh for the new row.

### 7.4 Client-safe projection (`src/server/queries/portal.ts`, types `PortalJob`, `PortalJobDetail`)

Built by a whitelist mapper `toPortalJob()` — never spread a DB row.

| Field | Source |
|---|---|
| `id`, `jobNumber`, `name` | jobs |
| `project` `{ id, name, address }`, `jobTypeName` | projects / job_types |
| `milestone` ∈ `CLIENT_MILESTONES` or null (cancelled), `milestoneLabel`, `milestoneDetail`, `updating: boolean`, `cancelled: boolean` | mapping below |
| `shootDate`, `deliveryDueDate` (the agreed delivery date), `deliveredAt` (the timestamp of the latest transition into delivered/completed, when `milestone = delivered`; else null), `cancelledAt` | jobs / transitions |
| `photographer` `{ name }` or null | users (name only) |
| `links[]` `{ id, kind, label, url, provider }` | §7.3 |
| `deliveryNotes[]` `{ id, body, createdAt, authorName }` | `job_notes` kind `delivery`, not archived |
| `feedback[]` threads `{ id, body, authorName, isClient, createdAt, editedAt, deleted, replies[] }` | `job_comments` kind `client_feedback` whose root author has `users.client_id = ctx.clientId` (deleted → placeholder) |
| `canGiveFeedback` | `portal.give_feedback` |

Never in the projection: editor ids/names, status ids/names, status category, priority, `due_date`, `review_due_date`, revision counts/rows, internal / photographer / editor / client / revision notes, any non-`client_feedback` comment, time tracking, assignment history, activity events, other clients, emails.

**"Agreed production milestones"** = the four fixed milestones plus the two agreed dates the studio records: `shootDate` and `deliveryDueDate`. There are no per-client custom milestones.

**Milestone mapping** (`clientMilestone({ category, shootDate, everDelivered }, now, tz)` in `src/lib/portal.ts`, pure). Dates compare as **calendar days in the org timezone** (`civilDate(shootDate, tz)` vs `todayCivil(tz, now)`), because `shoot_date` is a UTC instant and deadlines are end of day in the org timezone. `everDelivered` = the job has a transition into `delivered` or `completed`.

| Condition (first match wins) | Milestone | Label (detail) |
|---|---|---|
| category = cancelled | null | "Cancelled" ("Cancelled by the studio on 12 Oct") |
| category ∈ {delivered, completed} | `delivered` | "Delivered" ("Delivered 18 Oct") |
| `everDelivered` (reopened after delivery) | `delivered`, `updating = true` | "Updating your delivery" ("Your delivered files stay available") |
| category ∈ {new, ready, assigned, accepted} ∧ (shoot date null ∨ shoot day > today) | `booked` | "Booked" ("Shoot scheduled for 12 Oct" / "Shoot today" when the shoot day = today; no detail when null) |
| category ∈ {new, ready, assigned, accepted} ∧ shoot day < today | `shot` | "Shot" |
| category ∈ {new, ready, assigned, accepted} ∧ shoot day = today | `booked` | "Booked" ("Shoot today") |
| category ∈ {in_progress, submitted, review, revision, resubmitted, approved} | `editing` | "Editing" |

An editor-created job without a shoot date shows "Booked" until editing starts; the editor's create form pre-fills today's date (§4.3), so this is rare.

### 7.5 Feedback threads
- Clients: `POST /api/portal/jobs/:id/feedback { body, parentCommentId? }` → `portal.give_feedback`. A root, or a reply inside an existing `client_feedback` thread of the same job started by their client. Stored in `job_comments` with `kind = "client_feedback"`, author = the client user, event `comment.added` (visibility `all`). Edit own within 15 min (`PATCH /api/portal/comments/:id`), soft-delete own (`DELETE /api/portal/comments/:id`).
- **Portal comment routes**: load the comment, then its job through `portalJobsWhere` (job outside → 404), then require `comment.kind === "client_feedback" ∧ comment.authorUserId === ctx.userId` (else 404). Edit additionally needs `portal.give_feedback` and the 15-minute window (else 403/422). `can()` evaluates the client cells of `comment.edit` / `comment.delete` from `CommentPermissionRef { kind, rootKind, authorUserId, createdAt }` plus the `PortalJobRef`.
- Staff: replies with `kind = "client_feedback"` and `parentCommentId` in that thread (`client_feedback.reply`); visible to the client. The comment service enforces: a reply's kind equals its root's kind when the root is `client_feedback`; a non-`client_feedback` thread cannot contain `client_feedback` replies; a `client_feedback` root can only be created by a client.
- **Turn into revision request** (staff, `client_feedback.to_revision`): action on a client thread that opens the Request revision dialog prefilled with the quoted feedback; `revision.requested` carries `metadata.fromFeedbackCommentId`. Only on jobs whose category allows `revision.request`.
- Bodies render as **plain text** everywhere (portal and staff; no HTML, no markdown links); URLs in links render with `target="_blank" rel="noopener noreferrer"`.
- Everything else on the job (all other comments, notes except delivery) is invisible to clients.
- Notifications: client post → `client_feedback` to the job's photographer, its creator (if a photographer) and all admins (minus actor; editors are not notified; one notification per user). Staff reply → `client_feedback_reply` to every active portal user of the job's client. Clients never receive `comment_added` / `mentioned`.
- A thread is **waiting** while its last message is from the client; waiting threads appear in the `questions` widget (§9).

### 7.6 Other client notifications
- `client_work_delivered`: when a client-visible job enters `delivered`, or enters `completed` with `delivered_at` null (workflows without a delivered stage), including when the delivery step itself shares the job; dedupeKey `client_delivered:<jobId>:<userId>:<transitionId>`.
- `client_work_shared`: when a job (or a project) becomes shared by an explicit share action — one notification per share action per client user (project share: "12 jobs at 14 Ocean Street are now available"). Not for jobs created into an already-shared project.
- All link to `/portal/jobs/:id` or `/portal`. Built inside the same transaction as the event (`notify` as usual).
- **In-app only.** No email channel exists (`registerNotificationChannel` has no production caller). Email delivery for clients is a follow-up (§16 Q5); until then the invite message (§6.1) tells clients to check the portal, and the portal empty state says so.

### 7.7 Portal surface
Pages (`src/app/portal/…`, its own `layout.tsx`, NOT under `(app)`):
- `/portal` — "Your work": jobs grouped by project, milestone stepper (Booked → Shot → Editing → Delivered; "Updating your delivery" keeps the stepper on Delivered with a note), delivered-first sort option, cancelled jobs in a muted "Cancelled" row for 30 days, empty state "Nothing has been shared with you yet. Your studio will let you know."
- `/portal/jobs/[id]` — milestones with dates, finished-work links (open in new tab, `rel="noopener noreferrer"`), delivery notes, feedback threads (+ composer when allowed; disabled notice when not).
- `/portal/notifications`, `/portal/account` (name, password, notification toggles for the three client types).
- Header: studio name + client name, bell, account menu. No sidebar, no search, no ⌘K.

APIs (`src/app/api/portal/**`, all via `requirePortalContext()`): `GET /api/portal/jobs`, `GET /api/portal/jobs/:id`, `POST /api/portal/jobs/:id/feedback`, `PATCH|DELETE /api/portal/comments/:id`, `GET /api/portal/notifications`, `POST /api/portal/notifications/:id/read`, `POST /api/portal/notifications/read-all`, `GET|PUT /api/portal/notification-prefs`, `PATCH /api/portal/me { name }`. Same JSON/405/CSRF conventions as the staff API.

`GET /api/auth/me` (via `requireAnyContext`) returns a **client-safe shape** for clients: `{ kind: "client", name, email, clientName, studioName, unreadCount }` — never `settings`, flags or staff fields. Staff get the existing shape plus `persona`, `isAdmin`, `isPrimaryOwner`, effective flags.

### 7.8 Routing guards (UX in the proxy, security in layouts and `requireContext`)
- Session JWT gains claim **`k`: `"staff" | "client"`** (set at login from the role; a missing claim = staff). `verifySessionToken` returns it.
- `src/proxy.ts` (still no DB, no signature check — routing only): reads `k` with jose `decodeJwt` (unverified); `/login` with a cookie → `/portal` for clients, `/dashboard` for staff; a client cookie on a staff page → redirect `/portal`; a staff cookie on `/portal*` → redirect `/dashboard`. API paths are never redirected.
- `src/app/(app)/layout.tsx` and `pageContext()`: a client context → `redirect("/portal")`. `src/app/portal/layout.tsx` / `portalPageContext()`: a staff context → `redirect("/dashboard")`. `src/app/page.tsx`: by persona.
- Login: success response carries `redirectTo` (`/portal` for clients; for staff the `next` param or `/dashboard`); a client's `next` pointing outside `/portal` is ignored. Wrong password, inactive account, **and** a client whose portal is off or whose client is archived all get the **same generic 401** (`services/auth.ts` L72-79 behaviour): no credential-validity oracle. The login page shows under the error: "Client of a studio? If you can't sign in, your studio may have turned off portal access."

---

## 8. Personal vs business view (scope switch)

- Shown to `view.business_scope` holders (admins; members with `can_view_all_jobs`): a segmented control **My shoots | Whole business** in the topbar (≥ md), and as two radio items in the account menu on small screens.
- `POST /api/me/scope { scope: "mine" | "business" }` sets cookie `pwm_scope` (path `/`, sameSite lax, httpOnly, 1 year); not audited (a UI preference, like appearance). Then `router.refresh()`.
- **One resolver, used by every route and page** (`src/server/view-scope.ts`):
  ```ts
  /** null = no scope filter: the actor's visible set is already personal. */
  export async function resolveScope(ctx, requested?: string | null): Promise<ViewScope | null>;
  //  !can(ctx, "view.business_scope")           → null   (any ?scope= param is IGNORED, never an error)
  //  requested ∈ VIEW_SCOPES                     → requested   (param wins over the cookie)
  //  else cookie value ∈ VIEW_SCOPES             → cookie
  //  else                                         → "business"
  export function myShootsWhere(ctx): SQL;        // jobs.photographer_id = me   (photographers only; else 1 = 0)
  export function scopedJobsWhere(ctx, scope): SQL;   // and(visibleJobsWhere(ctx), scope === "mine" ? myShootsWhere(ctx) : undefined)
  export function resolveMetricScope(ctx, scope): { metric: "org" | "visible"; extra?: SQL };
  //  hasBusinessView(ctx) ∧ scope === "business" → { metric: "org" }
  //  scope === "mine"                            → { metric: "visible", extra: myShootsWhere(ctx) }
  //  otherwise (null)                             → { metric: "visible" }
  ```
- **"My shoots" = `photographer_id = me` only.** `managesJob` (photographer ∨ creator) is a permission concept and is never a view scope: an owner who creates jobs for photographer02 does not see them in My shoots.
- **Applies to**: Dashboard KPIs and job lists/widgets marked "scope" in §9, All Work, Jobs, Kanban, Calendar, Timeline, Activity Log. List APIs (`GET /api/jobs`, `/api/kanban`, `/api/calendar`, `/api/timeline`, `/api/activity`, `/api/dashboard`) accept `?scope=mine|business`, resolved by `resolveScope`.
- **Review duties ignore the personal filter partially**: in `mine` scope an admin's `awaiting_review` and `questions` widgets include `myShootsWhere` ∪ **jobs only an admin can review** (`needsAdminReviewWhere`: no active member who manages the job has ⚑review, or the creator was an editor and the photographer lacks ⚑review), and show a footer "N more waiting in Whole business →" for the rest. **My Work** for an admin always includes "Reviews waiting for me" = every job in `REVIEWER_HOLDS` where the admin is the only effective reviewer, plus their own shoots, regardless of scope.
- **Does not apply to**: workloads, analytics, bottlenecks, performance, reports, Team Work, search, My Work (always personal + review duties above), clients/projects counts (these use `resolveMetricScope(ctx, null)`).
- **Analytics for a ⚑analytics member without ⚑all**: aggregate numbers are org-wide (`metric: "org"` is allowed for `analytics.view` holders on Insights pages only), but every **job-level row** (bottleneck job lists, report rows, per-job CSV exports, drill-downs) is filtered by `visibleJobsWhere(ctx)`. Same guarantee in `bottlenecks.ts` (already), `reports.ts`, `export.csv` and `analytics` drill-downs; one test per surface.
- Page headers show the active scope ("Showing: My shoots") with a one-click switch back.

---

## 9. Dashboards per persona

`defaultLayoutFor(persona)` (was by role) and `allowedWidgetTypes(ctx)`:

| Widget | Admin | Member | Editor | Scope-aware |
|---|---|---|---|---|
| `kpis` (Active, Unassigned, In editing, Awaiting review, Revision required, Overdue, Due today, Completed this week) | ✓ | ✓ (visible jobs) | ✓ (assigned) | yes |
| `my_shoots` (new: active jobs where I am the photographer, by next step) | ✓ | ✓ | – | always mine |
| `awaiting_review` (new: REVIEWER_HOLDS, oldest first, Review action) | ✓ (mine ∪ admin-only reviews, §8) | ✓ if ⚑review (managed jobs) | – | yes |
| `questions` (new: open editor questions + waiting client feedback, §6.4/§7.5) | ✓ (mine ∪ admin-only, §8) | ✓ (managed jobs) | – | yes |
| `due_today`, `overdue` | ✓ | ✓ | ✓ (assigned) | yes |
| `upcoming_deadlines` (new: due / review due / delivery due in the next 7 days) | ✓ | ✓ | ✓ (assigned) | yes |
| `revisions` (new: open revisions + resubmissions, revision #) | ✓ | ✓ (visible) | ✓ ("Revisions to address", assigned) | yes |
| `recent_completed` (copy: "Recently delivered & completed", last 14 days) | ✓ | ✓ | ✓ (jobs they edited = own history) | yes |
| `recent_activity` | ✓ (incl. management events) | ✓ (visible jobs) | ✓ (visible jobs, cut-off) | yes |
| `team_workload` (editor workloads & capacity; each editor row links to `/jobs?editorId=<id>&group=active` = "jobs assigned to editors" drill-down) | ✓ | ⚑workloads | – | no (business) |
| `bottlenecks`, `completion_rate`, `revision_rate`, `editor_performance` | ✓ | ⚑analytics | – | no (business) |
| `turnaround` (new: median shoot → delivered and submitted → reviewed, last 30 days vs previous 30; from `queries/analytics`) | ✓ | ⚑analytics | – | no (business) |
| `my_workload` | – | – | ✓ | – |
| `my_performance` | – | ✓ | ✓ | – |
| `calendar` | ✓ | ✓ | ✓ | yes |

Admin default order: kpis · my_shoots · awaiting_review · questions · overdue · upcoming_deadlines · team_workload · revisions · recent_completed · recent_activity · turnaround · bottlenecks · completion_rate · revision_rate · editor_performance. Member: kpis · my_shoots · awaiting_review · questions · due_today · overdue · upcoming_deadlines · revisions · recent_completed · my_performance · recent_activity (+ flagged widgets). Editor: the personal variant (queue preview "My queue": To accept · In progress · Revisions to address · Paused · Created by me, not started) · due_today · overdue · upcoming_deadlines · my_workload · my_performance · recent_completed · recent_activity.

`DashboardData.variant`: `"business"` (admin or ⚑all member in business scope) | `"personal"`.

**Historical workload** ("every editor's … historical workload"): Performance → editor detail (`/team/users/[id]`, performance tab) gains a **Workload history** chart: jobs assigned, completed and revisions per week for the last 12 weeks, from `job_assignments` + `job_status_transitions`; also available as a Reports preset "Editor workload by week". Gated like performance (admin, ⚑analytics).

---

## 10. Navigation (`src/config/nav.ts`)

Items lose `roles`/`grant`; each item takes an optional **`gate: NavGate`** computed server-side in `src/app/(app)/layout.tsx` with `can()` into `NavGates: Record<NavGate, boolean>`; no gate = every staff persona. Clients never get this nav (portal has its own).

| NavGate | True for |
|---|---|
| `admin` | `isAdmin` (settings items, Invite, Settings quick action) |
| `createJobs` | `job.create` (A, M ⚑create, E ⚑create) |
| `createClients` | `client.create` (A, M ⚑create) |
| `teamWork` | A ∨ M ⚑all ∨ E ⚑teamJobs |
| `directory` | `team.view_members` (A, M) |
| `teamWorkloads` | `workloads.view_team` |
| `analytics` | `analytics.view` (also gates Performance) |

Exact matrix (✓ shown, – hidden). "M default" = flags at invite defaults; "M all flags" = photographer01; "E team" = editor02.

| Item | Admin | M default | M all flags | Editor | E team |
|---|---|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| All Work · My Work · Kanban · Calendar · Timeline | ✓ | ✓ | ✓ | ✓ | ✓ |
| Team Work | ✓ | – | ✓ | – | ✓ |
| Jobs · Projects · Clients | ✓ | ✓ | ✓ | ✓ | ✓ |
| Photographers · Editors (directories) | ✓ | ✓ | ✓ | – | – |
| Workloads | ✓ | – | ✓ | – | – |
| Performance · Analytics · Bottlenecks · Reports | ✓ | – | ✓ | – | – |
| Activity Log | ✓ | ✓ | ✓ | ✓ | ✓ |
| Settings: Organisation · Users · Roles · Teams · Workflows · Job Types · Automations | ✓ | – | – | – | – |
| Settings: Notifications | ✓ | ✓ | ✓ | ✓ | ✓ |
| Quick action New job (topbar primary) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Quick actions New project · New client | ✓ | ✓ | ✓ | – | – |
| Quick actions Invite a user · Settings | ✓ | – | – | – | – |
| Scope switch (§8) | ✓ | – | ✓ | – | – |
| Mobile tabs: Home · My Work · Kanban · Search · More | ✓ | ✓ | ✓ | ✓ | ✓ |

(A member or editor with `can_create_jobs` off loses New job, and members also New project / New client.) The command palette uses the same gates. `/team/users/[id]`: admin, self, members with ⚑workloads or ⚑analytics (editor pages only; §3.4). `/settings/profile` gains a **"Your access"** card for every staff persona: persona label + all eight switch rows of §2.2 (or the two editor rows) in plain English, locked rows marked "Always on".

Client portal nav: Your work · Notifications (bell) · Account · Log out.

### 10.1 Team Work (`queries/teamWork.ts`)
- Rows: `scopedJobsWhere(ctx, null)` (= `visibleJobsWhere`) ∧ active ∧ person column not null. `allowedPeople` and every use of `teamUserIds` are removed.
- Grouping: admins and ⚑all members by editor or photographer; editors with ⚑teamJobs by editor only.
- **Group counts** (active / overdue per person): shown only with `workloads.view_team`; editors see a count only on their own group; others see the job list without per-person counts.

### 10.2 Directories (`queries/users.ts` `directoryStats`)
- Members see: name, title, persona, active-job count of **editors** only with ⚑workloads.
- `revisionRate`, `completedThisMonth` and every photographer-peer statistic: admin or ⚑analytics only.

---

## 11. UI & copy

- **Role badge** everywhere (`personaLabel(user)` + `· {title}` when set): "Owner / Photographer", "Photographer (team member)", "Editor", "Client". Admin badge variant `solid`, member `info`, editor `neutral`, client `outline`. The primary owner additionally shows "Owner" in Users and pickers.
- **Invite dialog** (`/settings/users?invite=1`): role picker with three cards —
  - *Photographer* — "Shoots and works on their own jobs. You choose what else they can do." → checkbox **"Make admin (co-owner)"** (off; warning "Admins can change every setting, every job and every person except the primary owner.") and, unless admin, the eight rows of §2.2 (two locked "Always on", six switches at their invite defaults) plus the live "They'll be able to: …" summary.
  - *Editor* — "Edits the jobs assigned to them and can create jobs for a photographer." → switches "Create jobs" (on) and "See other editors' jobs (read-only)" (off).
  - *Client* — "Sees only the work you share with them, in a simple portal." → client picker (portal-enabled clients only; link "Turn on the portal on the client's page").
- **User detail** (`/settings/users/[id]`): Access section = role (photographer ⇄ editor), Admin switch, permission switches (disabled with "Admins have every permission" while admin), lifecycle (unchanged; on the primary owner every control is disabled for other admins with "Only {name} can change their own account"). The primary owner's own page shows **Transfer primary ownership**. Client users: client link, portal state, reset password, deactivate.
- **Users list**: tabs **Team** (photographers + editors) · **Client portal users**; filter by persona; post-migration notice (§1.5).
- **Roles page** (`/settings/roles`, admin): intro **"Three roles: Photographer, Editor and Client. You are a Photographer with admin. Photographers you invite are team members whose switches you control."** → three role cards (Photographer — with the admin/team-member split inside the card; Editor; Client: what they see, what they can do, what they can't) → member switches list (eight rows, §2.2) → "Default photographer for jobs editors create: {name}" (link to Settings → Organisation) → matrix with columns Owner / Photographer · Photographer (team member) · Editor · Client rendered from `permissionMatrix()`; member cells show the needed switch. A note under the matrix: "Team members can cancel or re-date jobs someone else assigned to them only with Review submissions."
- **Settings → Organisation**: "Default photographer for jobs editors create" (active photographers; default the primary owner).
- **Job detail**: header buttons **What the client sees** (opens a read-only staff preview built from the same `toPortalJob`) and, on deliverable jobs, **Deliver…** (opens the §7.3 dialog). Overview "Client" panel — *Shared with client* switch (or "Shared through project 14 Ocean Street"), portal state of the client. Links tab: "Visible to client" badge + share toggle per current link. Notes: kind *Delivery note — visible to the client*. Comments: client threads shown first with a "Client" badge, a composer warning "Your reply is visible to the client", and **Turn into revision request**. Job form: `deliveryDueDate` labelled "Delivery date — visible to the client when shared".
- **Project detail**: admin switch "Share every job in this project with the client" with the hint "Jobs added later are shared too."
- **Workflow editor**: role chips per §5.2.

### 11.1 Topbar menu behind sticky headers (bug fix)
Cause: `topbar.tsx` is `sticky top-0 z-20` with `backdrop-blur` (its own stacking context), and `job-header.tsx` is `lg:sticky lg:z-20` later in the DOM, so the header paints above the topbar and the account menu's `z-50` cannot escape the topbar's context.

Fix — one global layering scale in `src/app/globals.css` (`:root` custom properties) used through `z-(--z-…)`:

| Token | Value | Used by |
|---|---|---|
| `--z-content` | 10 | in-content sticky table headers, row highlights (`z-10`, `z-[1]`, sticky first columns `z-20` stay as they are: they live inside scroll containers) |
| `--z-page-sticky` | 20 | page-level sticky headers/bars: job header (desktop), dashboard edit bar, sticky form footers, automation/org form save bars |
| `--z-shell` | 30 | sidebar, mobile tab bar, the job header's mobile fixed action bar, bulk-actions bar, timeline sticky header |
| `--z-topbar` | 40 | **topbar** (`sticky top-0 z-(--z-topbar)`) — above every page-level sticky element |
| `--z-popover` | 50 | dropdowns, popovers, tooltips, calendar popover; **rail tooltips** (see below) |
| `--z-toast` | 100 | toaster |

- **Rail tooltips** (`src/components/shell/rail-tooltip.tsx`, rendered inside the sidebar, which is `fixed z-30` and therefore its own stacking context): portal the tooltip to `document.body` (`createPortal`) so its `z-(--z-popover)` is evaluated at the root; otherwise a tooltip that extends into the topbar band paints under the raised topbar.
- The mobile nav drawer is the `Sheet` primitive (`<dialog>` top layer, `app-shell.tsx` L162), so the topbar cannot cover it; dialogs/sheets keep using the native top layer.
- No page element may use a z-index ≥ `--z-topbar`.
- Regression e2e (§12.2): on `/jobs/[id]` at 1280×800 and 390×844, open the account menu and assert `document.elementFromPoint` at the centre of every menu item lands inside the menu; same for the job header's own action menu (must not be covered by the topbar when scrolled); hover the first rail item with the sidebar collapsed and assert the tooltip's centre point hits the tooltip; open the mobile drawer and assert its first link is the hit target at its centre.

---

## 12. Tests

### 12.1 Unit / integration (vitest)
- **Fixtures** (`src/db/test-db.ts`): `FixtureUserKey = "owner" | "coAdmin" | "lead" | "photographer1" | "photographer2" | "editor1" | "editor2" | "inactiveEditor" | "client" | "client2"`; ids `${slug}-${key}`; emails `owner@`, `coadmin@`, `lead@`, `photographer01@`, `photographer02@`, `editor01@`, `editor02@`, `editor99@`, `client@`, `client2@<domain>`. `owner` = primary owner (admin); `coAdmin` = admin; `lead` = member with every flag on (= a migrated manager); `photographer1/2` = members with the **migrated** defaults (create ✓, assign ✓, review ✓; v1 behaviour, keeps existing tests meaningful); editors at defaults; `client` belongs to `clientId` (portal + feedback on), `client2` to a second client `clientId2` / `projectId2` (portal on, feedback off). `SeedIds` gains `clientId2`, `projectId2`. `contextFor()` builds effective flags. Helpers `setUserFlags(db, userId, flags)`, `inviteDefaultsMember(db)` (creates a member with invite defaults: review ✗).
- **Porting rule for `manager`** (~300 references): a test that used `manager` as *a second management user acting on any job* → `coAdmin`; a test about *manager limits* (cannot manage settings, can only target P/E, read-only workflows) → rewrite as the member equivalent with `lead` or as an admin-only assertion; `manager1@studio.test` in e2e → `owner@studio.test` or `photographer01@studio.test` per intent. `OMP`/`OME` arrays in tests → `["photographer"]` / `["admin", "editor"]`. Never delete an assertion; if a behaviour no longer exists (e.g. managers limited to P/E targets), replace it with the nearest v2 rule and say so in the report.
- `server/auth/permissions.test.ts` — table-driven over **every action × persona × resource situation** {managed-own, managed-assigned-by-owner, photographer-only, creator-only, created-as-editor-then-photographer, assigned, working, frozen (review-gated), past, created, draft, draft-closed-by-start, draft-closed-by-admin-unassign, draft-closed-by-cancel, teamView, other, other-org, inactive actor, primary-owner target, shared (client), unshared (client), other client, cancelled shared <30 d, cancelled shared >30 d}; each member/editor flag on/off; `PERMISSIONS` persona keys = `POLICY` scope keys; `memberFlag`/`editorFlag` set exactly on flag-gated cells; self-review denial for every § action incl. admin-ex-editor; matrix snapshot.
- `server/auth/visibleJobs.pg.test.ts` — for every persona/flag combination, `visibleJobsWhere` rows = jobs where `canViewJob` is true (fixture of ~14 jobs covering every scope); `portalJobsWhere` = `portal.view_job`; clients get 0 rows from `visibleJobsWhere`; `myShootsWhere` for the owner excludes a job the owner created for photographer02.
- `server/view-scope.test.ts` — `resolveScope`: non-holders → null regardless of param/cookie; param beats cookie; default business. **Editor with `?scope=business` gets exactly the numbers of no param** on `/api/dashboard`, `/api/jobs`, `/api/kanban`, `/api/activity`; member without ⚑all likewise.
- `server/privacy.test.ts` — one assertion per §2.4 row (editor cannot read client contacts/notes via list, detail, options, search `q` by email; cannot read internal/client notes; assignment reasons hidden; past/created cut-off hides post-handover comments and the current editor's name; directory stats hidden).
- `db/migrations.roles-v2.test.ts` — boot PGlite, apply `0000` + `0001` SQL only, insert legacy data (owner, 2 managers, flagged photographer, editors, org flags on incl. `editors_see_team_jobs`, OMP/OME/OM-only/editor-only edges, automations with `managers`/`owner` targets, an automation with non-array `actions`, links added by owner and by an editor, **a second org whose owner is inactive with one active manager**, **a third org with no active photographer**), apply `0002` + `0003`: the third org makes 0003 RAISE (assert message, then fix the data and re-run); assert role/flag mapping, editors' `can_view_team_jobs` still false + the settings event listing them, ex-manager promoted in the second org with `user.admin_changed` cause migration, `primary_owner_user_id` set, `added_by_sharer` backfill, accurate summaries, edge mapping table §5.1, automation targets, CHECKs reject bad rows (`isCheckViolation`), triggers installed (31); then `verifyDerived` 0 drift.
- `server/services/users.test.ts` — invite each role (client needs portal-enabled client; member invite defaults review ✗; strict schema); set_admin grant/revoke; last-admin guard via service (422) **and** raw SQL (trigger message); primary-owner protection for every ¶ action by a co-admin (service 403 + trigger) and transfer; deactivating an admin clears admin, reactivation returns a member; concurrent demotion of the last two admins (two connections are not available on PGlite — assert the lock path by sequential attempts + trigger); role change rules (no self, no client ⇄ staff, flags reset, **photographer with open photographer jobs cannot become an editor**); set_permissions validation; client user login blocked when portal off/archived **with the generic 401**; `client_id` immutable (trigger); `GET /api/users/:id` for a client id → 404 for member/editor; `listUsers`/options reject `?role=client` for non-admins; search people never returns client users to members; team membership / mention / automation user target / saved-view share with a client user → 422.
- `server/services/jobs.test.ts` — create as admin / member (photographer forced, ⚑create off → 403, editorId without ⚑assign → 403) / editor (⚑create off → 403; photographer required + default from setting, falling back to the primary owner when the setting's user is inactive; inline new project under an existing client; client user as photographer → 422; self-assign via claim, other editor → 403, draft window edits allowed then closed after Start); **admin unassigns the creator-editor → creator's claim 403 and field edit 403**; `claimJob`; share toggle event + version; **client change**: share, move to client2 → job and links unshared, delivery notes archived, events with `reason: client_changed`; client gets 404, client2 sees nothing; moving a job into a shared project without `job.share_with_client` → 403 (editor in draft, member without ⚑review); `controls` rules (member cancels/re-dates an owner-created job: 403 without ⚑review, ok with it); `created_by_role` set and never updated.
- `server/services/workflow.test.ts` — every default edge with the new `allowed_roles`; admin on-behalf on editor edges; `admin`-only edge denies members; member without ⚑review cannot approve/deliver/complete/reopen; editor never approves; **photographer12-equivalent (assign ✗, review ✗) cannot unassign via `POST /transition` to ready, via a kanban drop, or via `POST /api/jobs/bulk/transition {toCategory: "ready"}`** (403, editor unchanged); a custom review → assigned / review → ready edge is denied to a member without ⚑review; self-review denied after editor → photographer role change; delivery step: `shareJob`, explicit `shareLinkIds`, default set excludes editor-added gallery links, links stay shared after reopen; `actionsForMove` = what `movesFor` offers.
- `server/services/links.test.ts` — share toggle (current only; superseded → 422; trigger freezes after supersede; `added_by_sharer` immutable); inheritance rule on replace/updateLink; editors cannot add/replace/remove any link once review-gated (submitted, review, approved, delivered); members without ⚑review blocked on client-facing kinds and shared links once review-gated; strict link schemas reject `sharedWithClient`.
- `server/services/comments.test.ts` — client_feedback roots only by clients; staff reply rules; kind consistency; mentions rejected; feedback_enabled gate; editors read but cannot reply; ⚑all member may comment on a non-managed visible job; portal edit/delete of another client's or a staff comment → 404; turn-into-revision prefill + metadata; question notifications route to admins when the photographer lacks ⚑review.
- `server/services/notes.test.ts` — delivery kind: who may add; editors can read delivery but not internal/client; internal still hidden from non-managing members.
- `server/services/notifications.test.ts` — `adminsOf`, `workloadWatchersOf`; client-type filter both ways; recipients of the four new types; delivered/shared dedupe; **owner as photographer ∪ creator ∪ admin gets exactly one `client_feedback`**; `editor_unavailable` job list filtered per member recipient; unassigned editor-created job notifies admins.
- `server/services/automationEngine.test.ts` — `add_note` with `delivery` rejected on write and skipped on run.
- `lib/validation/*.test.ts` — invite discriminated union, `AllowedRolesSchema` rejects `client`, automation target legacy read, **strict schemas**: each of the §3.5 keys sent to each listed schema → 400.
- `server/queries/portal.test.ts` — projection key set is EXACTLY §7.4 (deep key snapshot); milestone mapping; link visibility = shared current links only; client A cannot load client B's job / unshared / cancelled > 30 d (404); cancelled < 30 d shows Cancelled without links; feedback threads of a previous client absent after a client change; internal comments/notes never present.
- `lib/portal.test.ts` — milestones incl. shoot date null / future / today / past, a shoot instant at 23:30 UTC that is the next civil day in `Australia/Sydney`, `everDelivered` → "Updating your delivery", cancelled.
- `server/queries/dashboard.test.ts`, `jobs.test.ts`, `kanban.test.ts`, `timeline.test.ts`, `activity.test.ts` — scope `mine` vs `business`; `mine` = photographer only; members without ⚑all ignore `?scope`; admin `awaiting_review` in mine includes a photographer12-style job; `questions` widget contents.
- `server/queries/search.test.ts` — internal notes: admin any job, member managed only, ⚑all member gets no hit on another's internal note, editor never; email match admin only.
- `server/queries/teamWork.test.ts` — editor with ⚑teamJobs: no other-editor counts; grouping by editor only.
- `server/queries/analytics.test.ts` / `reports.test.ts` / export route test — ⚑analytics member without ⚑all gets only visible jobs in job-level rows.
- `config/nav.test.ts` — the §10 matrix for the five staff personas (snapshot).
- `app/routes.test.ts` (moved from `app/api/_lib/routes.test.ts`) — structural over **every `src/app/**/route.ts`**: outside `api/auth` and `api/portal`, the handler authenticates through `requireContext()` (or a helper that calls it) — this includes `src/app/(app)/activity/export/route.ts`; every `api/portal/**` route through `requirePortalContext()`; `/api/auth/me|logout|change-password` through `requireAnyContext()`; `/visibility` route gone; `/api/auth/me` returns the client-safe shape for a client.
- `db/verify.test.ts` — the seven new checks detect tampering.

### 12.2 E2E (Playwright) — one spec per persona + isolation
`e2e/api.ts` accounts: `owner` (primary owner), `photographer` (= photographer01, all flags), `photographer-noflags` (photographer02, migrated defaults), `photographer-restricted` (photographer12: create ✓, assign ✗, review ✗), `editor` (editor01), `editor-team` (editor02), `editor-overloaded` (editor03), `client` (client@studio.test), `client2` (client2@studio.test), `other-owner` (owner@other.test), `other-client` (client@other.test). `inviteUser(role: "photographer" | "editor" | "client", opts)`.
- `roles-admin.spec.ts` — owner sees everything; scope switch changes All Work/Kanban/Dashboard counts and persists across reload; creates a job for photographer02 that is absent in My shoots; grants/revokes co-admin; last-admin guard message; co-admin cannot deactivate the owner; invites a client user from the client page (Copy invite message); shares a job and a link; replies to client feedback; post-migration notice absent on a fresh seed.
- `roles-member.spec.ts` — photographer02 sees only managed jobs, no Team Work/Insights/Settings, 403 pages; photographer01 sees all jobs read-only (no Edit on others' jobs, can comment), scope switch, workloads + insights; photographer12 cannot approve (button absent, API 403), has no editor picker, has no "Move to Ready" on a job with an editor, and a kanban drop to New/Ready is rejected.
- `roles-editor.spec.ts` — editor creates a job (photographer defaults to owner, inline new project, self-assign), adds raw link, starts → fields locked; after submit the Links tab has no add/replace; cannot assign another editor (no control; API 403); cannot approve; editor01 cannot see editor04's job (404) while editor02 sees it read-only; no Team/Insights/Settings nav; client contact details absent on the client page.
- `portal.spec.ts` — client logs in → lands on `/portal`; sees Harbourline shared jobs with milestones, delivered links, delivery notes, feedback thread; posts feedback (staff notified); cannot open `/dashboard` (redirect) or any staff API (403); unshared jobs absent; cancelled job shown as Cancelled. **Delivery prompt**: owner delivers a shared job that has only `finished_files` → dialog pre-selects it → the client sees the link.
- `portal-isolation.spec.ts` — client2 sees the empty state and gets 404 for Harbourline job ids; other-client gets 404 for every Northlight portal id and Northlight staff ids; staff cookie on `/portal` redirects; editor cannot see client emails.
- Port existing specs: `permissions.spec.ts` (photographer without flags → photographer02), `dashboard.spec.ts`, `edge-cases.spec.ts` (manager → owner/photographer01), `regression-shell.spec.ts` (+ §11.1 z-index tests incl. rail tooltip and mobile drawer).

CI unchanged: typecheck → lint → test → build → db:reset → e2e.

---

## 13. Demo seed (`src/db/seed/**`)

**Northlight Studios**
- `owner@studio.test` — Hannah Brooks, **Owner / Photographer (admin), primary owner**, `default_photographer_user_id` = null (→ her). Bootstrapped with `is_admin = true`. Also shoots: ~12 % of jobs have `photographerKey = owner`. Every action the old seed performed as `manager1`/`manager2` (assign/cancel/restore/deadline/priority changes, teams, clients, automations, saved views, deactivation) is performed by the owner. **No manager accounts.**
- `photographer01@studio.test` — team member with `can_view_all_jobs`, `can_view_team_workloads`, `can_view_analytics`, `can_review_submissions` (+ create, assign); title "Senior photographer".
- `photographer02..11@studio.test` — team members with create ✓, assign ✓, review ✓ (passed explicitly to `inviteUser`: "established photographers").
- `photographer12@studio.test` — team member at **invite defaults** (`can_assign_editors = false` passed explicitly, `can_review_submissions = false`) ("Junior photographer — the owner reviews her work"). Seed rule: on her jobs the assigner/reviewer/completer is the owner.
- Seed rule for every scripted job: reviewer / completer / assigner must be able to act (admin, or the job's managing member with the flag, never someone who edited it); otherwise use the owner. Deliveries of shared jobs pass `delivery.shareLinkIds` explicitly.
- `editor01..13@studio.test` as before (editor11 deactivated holding 2 jobs, editor13 deactivated with history); **editor02 `can_view_team_jobs`**; editor09 `can_create_jobs = false`.
- **Editor-created jobs**: 6 jobs created by editor01 (4) and editor04 (2): photographer = owner (4) / photographer02 (2); one with an inline-created project; 4 self-assigned at creation (2 completed, 1 in progress, 1 assigned), 2 left unassigned (1 later claimed by its creator). One open editor question on an owner-reviewed job.
- **Clients & portal**: Harbourline Realty (`portal_enabled`, `feedback_enabled`) with **`client@studio.test`** (Sarah Kingsley, created via `inviteUser`). Project "14 Ocean Street" shared at project level: ≥ 1 completed job and ≥ 1 delivered job with shared `client_delivery` + `gallery` links (shared by the delivery step) and a delivery note, 1 in editing, 1 cancelled within the last 30 days (shown as Cancelled), one explicitly shared `reference` link (floor-plan PDF) on an in-progress job; project "7/22 Campbell Parade" NOT shared, but 2 of its jobs shared individually (1 delivered with only `finished_files`, shared through the Deliver dialog; 1 booked with a future shoot date). One feedback thread: client message → owner reply → client follow-up (waiting); plus an internal staff comment and an internal note on the same job (must never reach the portal). Coastal Key Property: `portal_enabled`, feedback off, **`client2@studio.test`** (Daniel Ward), nothing shared.
- Automations: notify targets `"admins"`; names "Submitted → notify admins", etc. No `delivery` note actions.
- Workflow role arrays in `src/db/seed/org.ts` (`OME`, `OMP`, the Video workflow's custom edges) and `src/db/test-db.ts` (`OMP` cancel edges) use the §5.1 values: `OMP` → `["photographer"]`, `OME` → `["admin", "editor"]`.
- Dashboards: layouts for owner (admin default) and editor01.

**Other Studio** (isolation): `owner@other.test` (admin, primary owner), `editor@other.test`, client "Other Realty" (portal on) with **`client@other.test`** and 1 shared delivered job.

`summary.ts` / §39 assertions: + exactly one primary owner per org and it is an active admin, ≥ 1 portal user with ≥ 2 visible jobs, editor-created jobs ≥ 6, 0 users with legacy roles, every delivered shared job has ≥ 1 client-visible link; `db:verify` 0 drift.

**Login demo box** (`src/app/(auth)/login/login-form.tsx`), all `Password123!`:

| Email | Shown as | Note |
|---|---|---|
| owner@studio.test | Owner / Photographer | runs the business, shoots, reviews |
| photographer01@studio.test | Photographer (team member) | sees all jobs, workloads & analytics |
| photographer02@studio.test | Photographer (team member) | own jobs; reviews their own shoots |
| photographer12@studio.test | Photographer (team member) | junior: the owner reviews her work |
| editor01@studio.test | Editor | assigned jobs; can create jobs |
| editor02@studio.test | Editor | + sees other editors' jobs |
| client@studio.test | Client | Harbourline Realty portal |

`CLAUDE.md` demo-login paragraph updated to match (and "28 integrity triggers" → 31).

---

## 14. Work packages (suggested ownership for parallel agents)

Order: **A first** (others compile against it), then B–G in parallel, H last.

| Pkg | Owns | Deliverables |
|---|---|---|
| **A Foundation** | `src/lib/constants.ts`, `src/lib/types.ts`, `src/db/schema.ts`, `drizzle/0002*`, `drizzle/0003*`, `drizzle/meta/*`, `src/db/guard.ts`, `src/db/errors.ts`, `src/server/auth/session.ts`, `src/server/auth/permissions.ts` (+ test), `src/server/view-scope.ts` (resolver only), `src/lib/validation/json.ts` (automation target, `AUTOMATION_NOTE_KINDS`, `AllowedRolesSchema`), `docs/ARCHITECTURE.md` §2.1/§3 pointer to this file | §1, §2, §3 (incl. self-review, primary-owner rules, `draftClosed` in `loadJobRef`), §5.1 data, `portalJobsWhere`, `myShootsWhere`, `resolveScope`, gate actions, `requireContext`/`requirePortalContext`/`requireAnyContext` |
| **B Job & workflow services** | `services/jobs.ts`, `assignments.ts`, `workflow.ts`, `revisions.ts`, `src/lib/workflow.ts`, job API routes incl. `claim`, `share`, transition `delivery` payload | §4 (incl. §4.5 client change), §5.2 (`actionsForMove`, applyMove unassign check), delivery step §7.3, on-behalf, allow-list targets |
| **C Collaboration services** | `services/links.ts`, `notes.ts`, `comments.ts`, `notifications.ts`, `automationEngine.ts`, `sweep.ts`, link/note/comment routes, `src/server/audit.ts` summaries (`src/lib/audit-summaries.ts`) | §3.3 † rules, §6.2–§6.4, §7.3 sharing/inheritance, §7.5, §7.6, new events |
| **D Users, clients, settings services + admin UI** | `services/users.ts`, `clients.ts`, `projects.ts`, `settings.ts`, `workflows.ts` (role validation), validation files (strict schemas §3.5), users/clients/projects/organisation routes, `src/components/settings/**`, `settings/users`, `settings/roles`, `settings/organisation`, `settings/workflows`, client & project detail portal/share cards | §1.5, §3.4 user rules, §3.5, §6.1, §7.1, §7.2 share routes, §11 UX |
| **E Read side + scope** | `src/server/queries/**` (except `portal.ts`), `/api/me/scope`, list/dashboard/kanban/calendar/timeline/activity routes, `services/dashboards.ts`, dashboard components | §2.1 pinned ports, §2.3 cut-off, §2.4, §3.4 options, §8, §9, §10.1, §10.2 |
| **F Shell, nav, routing** | `src/config/nav.ts` (+ test), `src/components/shell/**`, `src/app/(app)/layout.tsx`, `src/server/page.ts`, `src/proxy.ts`, `src/app/page.tsx`, login form/page, `/api/auth/me`, `globals.css` z tokens, `job-header.tsx` z classes + Deliver/What the client sees buttons, every other z-index listed in §11.1, command palette, profile "Your access" card, job-detail client panel | §7.7 `/api/auth/me`, §7.8, §8 control, §10, §11, §11.1 |
| **G Portal** | `src/app/portal/**`, `src/app/api/portal/**`, `src/server/queries/portal.ts`, `src/lib/portal.ts`, `src/components/portal/**` | §7.4–§7.7 |
| **H Seed, fixtures, e2e** | `src/db/seed/**`, `src/db/test-db.ts`, `src/db/verify.ts`, `e2e/**`, `CLAUDE.md`, `src/app/routes.test.ts` | §1.4, §12.2, §13, fixture contract §12.1 |

Every package ports the unit tests of the files it owns (§12.1 porting rule) and runs `npm run typecheck`, `npm run lint` on its files and `npm run test` before reporting. Shared files outside your package: minimal, additive, and say so in the report.

---

## 15. Decisions log (roles v2)

| Topic | Decision |
|---|---|
| Admin model | `is_admin` on photographers; persona derived; ≥ 1 active admin enforced by service (friendly 422) and trigger `users_keep_admin` (`FOR NO KEY UPDATE` on the org row). Admins may grant/revoke admin to other photographers; never to/from themselves. |
| Primary owner | One per org (`organisation_settings.primary_owner_user_id`); other admins cannot demote, deactivate, re-role, re-email, rename or reset them; transfer only by the primary owner. Implements "the only role with full administrative control by default" while allowing co-owners. |
| Deactivated admins | Deactivation clears admin (audited); reactivation returns a team member. |
| Edge roles | `TransitionRole = admin \| photographer \| editor`; lossless mapping (§5.1). Edge roles are a first gate only; `actionsForMove` applies the action rules (incl. ⚑assign for unassigning and ⚑review for any move out of a review-gated stage). |
| Migrations | 0002 generated DDL + 0003 custom data/constraints/triggers; accurate `user.role_changed` summaries; orgs without an active admin get one (ex-manager first) or the migration aborts; `editors_see_team_jobs` not migrated (would widen), recorded and surfaced in the post-migration notice. |
| Ex-managers | Become team members with every switch on; manage only their own jobs. Not auto-promoted (except orphaned orgs); admins see a one-time "Make admin?" notice. **Needs user confirmation (§16 Q2).** |
| Org visibility switches | Replaced by per-user flags; columns kept as deprecated; team-based job visibility retired (teams remain for grouping). `editors_see_team_workloads` has no successor: editors never see other editors' workloads, including Team Work counts. |
| Editor team flag | `can_view_team_jobs` = read-only view of every job held by an editor (not team-scoped: works without teams). This is the spec's "unless explicitly permitted". |
| "All users should be able to create jobs" | Read as **all staff**: admins always; members and editors behind a `can_create_jobs` switch that defaults on (spec §4 lists "creating jobs" as configurable for photographers; the editor switch answers "no way to stop an editor creating jobs"). Clients cannot create jobs. **Needs user confirmation (§16 Q1).** |
| Editor-created jobs | Photographer required (default = org setting, else primary owner); editor self or none (`job.claim`); inline project under an existing client; creator draft window that closes for good on start, on cancel, or when anyone else removes an editor; editors never manage, approve, cancel or share. |
| Members: own vs assigned | "View their own jobs" and "View jobs assigned to them" are always on (the scope `managed`) rather than switches — a team member who cannot see their own shoots is not useful. Both get field edits, reviews (⚑review) and editor assignment (⚑assign); **cancel, restore, deadlines/priority and client/project changes on jobs someone else created need ⚑review** (`controls`). Creation counts toward "manages" only when the creator was a photographer at creation (`created_by_role`). |
| New-invite defaults | Review submissions ✗ for new invites (owner reviews by default); ✓ for migrated photographers (v1 behaviour). |
| Self-approval | Nobody may review/approve/deliver/complete a job they edited (hard rule, all personas). A photographer approving an editor's work on a job they shot and created is allowed — that is the normal review. |
| ⚑all members and comments | ⚑all members may comment and @mention on every visible job; every other write needs managed/controls. Copy says so. |
| Private information | Defined by the §2.4 list; editors' past/created access has a read cut-off and hides the next editor's identity. |
| Performance pages | Gated with analytics (`⚑analytics`), not a separate flag; per-person revision rates and completed counts in directories need ⚑analytics too. |
| Client gate | `app.access` / `portal.access` gate actions; `requireContext()` is staff-only; proxy routes by an unverified JWT claim `k` for UX only; login failures are one generic 401. |
| Client data | Whitelisted projection (`toPortalJob`); milestones from categories + calendar-day shoot dates; "agreed milestones" = the four milestones + shoot date + delivery date; cancelled visible 30 days; delivery notes = new note kind; feedback = new comment kind with kind-consistent replies, plain text. |
| Link sharing | Only explicitly shared current links are client-visible; the delivery step shares links in the reviewer's name (dialog selection, or reviewer-added gallery/client_delivery by default); shares survive reopen; editors' links freeze at submission; inheritance on replace only when the actor may share. "Approved finished-work links" = links the studio shared at or after delivery. |
| Client/project moves | Need share permission when they could publish; a client change un-shares the job and its links and archives delivery notes; feedback threads are filtered by the viewer's client. Creating into a shared project is allowed (the project share covers future jobs). |
| Sharing columns | Written only by dedicated services; every generic schema is strict. |
| Automation targets | `managers` / `owner` → `admins` (data migrated; legacy values accepted on read). Automations cannot write delivery notes. |
| Scope switch | Cookie `pwm_scope`, default business; `?scope=` param wins over the cookie but is ignored for non-holders; "My shoots" = photographer only; never applies to workloads/analytics/bottlenecks/performance/reports/Team Work/search; My Work always includes admin-only reviews. |
| Email uniqueness | Global (login has no org picker). |
| Notifications | In-app only for clients in this change; org-level notification defaults out of scope (per-user prefs + automations). |
| Stacking | z-index token scale; topbar `--z-topbar` (40) above every page-level sticky element; rail tooltips portaled; drawer is a top-layer `<dialog>`. |

---

## 16. Decisions the user must confirm

Implementation proceeds on the **default** shown. Questions 2 and 3 block running `0003` against production (Supabase); the agents never run it.

| # | Question | Default in this contract |
|---|---|---|
| Q1 | "All users should be able to create jobs": does "users" include clients? Should the owner be able to switch creation off per photographer/editor? | Staff only; per-person switch, default on. An optional portal **"Request a shoot"** (client creates a draft request an admin turns into a job) is a possible follow-up, not built. |
| Q2 | Former managers become team members who manage only their own jobs (they lose any-job assignment, cancel, review and settings). Should any be promoted to admin automatically? | No automatic promotion (except orgs with no active owner); a one-time notice lets the owner promote them. |
| Q3 | Orgs where nobody active can become admin make the migration abort. OK to require a manual fix first? | Yes: abort with the org ids; the user reactivates someone and re-runs. |
| Q4 | New team members can't review/deliver by default (the owner reviews). OK? | Yes for new invites; existing photographers keep reviewing their own shoots. |
| Q5 | Client notifications are in-app only. Is email needed for launch? | Not in this change; follow-up adds an email channel via `registerNotificationChannel`. |
| Q6 | Editors with "See other editors' jobs" also see the owner's shoots while an editor works on them. OK? | Yes (it is editing work, not private information; §2.4). |

---

## Review log

Revision 2 applies the security review and the product review. Each item is listed with where it landed; rejected or modified items say why.

### Security review — blocking (all adopted)
1. **Cross-client leak via client/project change** → §4.5, §3.3 ◊, `job.change_client`; feedback filtered by root author's client (§7.4); additionally the job's **delivery notes are archived** on a client change (the review covered links and feedback, but delivery notes leaked the same way). `metadata.cause = 'client_changed'` was **modified** to `metadata.reason`, because `cause` is the actor-cause enum (user/automation/sweep/…) and mixing business reasons into it would break consumers that switch on it.
2. **Members unassigning editors through workflow moves** → §5.2 `actionsForMove` (array) + from-gate + the `applyMove` re-check; tests for transition, kanban drop and bulk transition.
3. **Unapproved editor content auto-published** → adopted in a stronger form: auto-publish by kind is **removed**; only explicitly shared links are visible, the delivery step shares in the reviewer's name (dialog) or by default only reviewer-added `gallery`/`client_delivery` (`job_links.added_by_sharer`); editors' links freeze once the job is review-gated (§3.3 †).
4. **Draft window / claim reopening after admin intervention** → `draftClosed` (started, editor removed by someone else, or ever cancelled) in `JobPermissionRef` (§2.1). The "ever cancelled" clause is an addition for the restore case the review mentioned.
5. **Migration widening and lock-out** → `editors_see_team_jobs` not migrated, recorded as an event and surfaced (§1.3 b, §1.5); orphaned orgs promote an ex-manager/photographer or RAISE (§1.3 b2).
6. **Deny-list role checks** → allow-list rule (§3.4) for every target kind; client ids 404 on user detail; `STAFF_ROLES` filters; negative tests (§12.1).
7. **Sharing/portal flags via generic schemas** → §3.5 (dedicated writers + strict schemas + tests).
8. **Scope param widening reads** → `resolveScope` / `resolveMetricScope` (§8) + test.
9. **`isManagement` ports that leak** → pinned table in §2.1, each with a test.
10. **Editors seeing client contacts / options widening** → separate option queries and editor stripping (§3.4, §2.4).
11. **Self-approval via role change** → hard self-review rule, `created_by_role`, and the existing role-change guard is kept (§3.4). The previous "open photographer assignments stay" text is withdrawn.

### Security review — improvements
- `FOR NO KEY UPDATE` in the last-admin trigger: adopted.
- `CASE` guard in 0003 (d): adopted.
- `delivery` excluded from automation notes; `AllowedRolesSchema` → `TRANSITION_ROLES`: adopted (§6.3, §5.1).
- Structural route test over every `src/app/**/route.ts`: adopted (§12.1).
- Client-safe `/api/auth/me`: adopted (§7.7).
- Login oracle: adopted (generic 401; static hint on the login page instead of a specific message).
- Job-specific watcher notifications: adopted (admins, plus per-recipient filtered lists; §6.2).
- Directory stats gating: adopted (§10.2).
- `users.client_id` immutable (trigger) and project-client-change share reset: adopted.
- Deactivated admin keeps `is_admin`: adopted as "deactivation clears admin" (simpler than a reactivation prompt, and the audit trail shows it).
- Team Work counts and `allowedPeople`: adopted (§10.1).
- Portal `rel`, plain-text bodies, `p.organisation_id` check: adopted.
- `/api/users/options?jobId=` restricted to `comment.mention`: adopted for every persona, not only editors (members get the same check; it costs nothing).

### Security review — spec gaps
- Private owner information: defined (§2.4), with tests.
- ⚑all copy vs rule: resolved in favour of **commenting allowed** (collaboration), copy updated; all other writes stay managed-only.
- Co-owner takeover: **primary owner** added (§0, §3.4, trigger).
- Ex-managers narrowing: notice + §16 Q2.
- Creating into a shared project: **accepted explicitly** (§4.5) rather than requiring `job.share_with_client`: requiring it would stop editors creating jobs in Harbourline's shared projects, the main use case, and a new job exposes only name/project/dates; moves still require it.
- Stopping editors from creating jobs: per-editor `can_create_jobs` (reuses the member column). An org-wide toggle was **rejected** as redundant with per-person switches. Editor-created job notifications: kept; unassigned ones also reach admins.
- `CommentPermissionRef` / portal comment routes: specified (§7.5, §2.1).
- Per-org email uniqueness: **rejected**. Login identifies the account by email alone, so per-org uniqueness would need an organisation picker or slugged logins, a larger change than roles v2. The invite error no longer names the other organisation or role; a contact working with two studios uses a second address. Recorded in §15.
- Role-change contradiction: the existing guard wins (§3.4).
- Scope precedence and analytics row filtering: specified (§8).

### Product review — blocking (all adopted)
1. "My shoots" = `photographer_id = me` (§8); test with an admin-created job for photographer02.
2. Milestones before the shoot: calendar-day rule in the org timezone (§7.4). **Modified**: assigned/accepted with a past shoot show "Shot" (not "Editing") until editing starts, and the shoot day itself shows "Booked — Shoot today".
3. Reopening keeps delivered work: shares are persisted at delivery and survive reopen; "Updating your delivery" label (§7.3, §7.4).
4. Delivered with nothing to open: Deliver dialog pre-selects `finished_files` when there is no gallery/client_delivery link, and warns before delivering with no links; service + e2e assertion.
5. Editors creating jobs for new properties: inline project creation under an existing client, plus the "Ask your studio owner to add this client" empty state (§4.3).
6. Migration summary and manager downgrade: accurate summary + post-migration notice + §16 Q2.

### Product review — improvements
- Admin-only reviews in "My shoots": adopted (`needsAdminReviewWhere` + "N more" footer; also for client feedback via the `questions` widget).
- Visible default-photographer setting: adopted (§4.3, §11).
- Notify admins about unassigned editor-created jobs: adopted.
- Six switches mapped 1:1 with locked "Always on" rows: adopted (§2.2).
- Assigned-photographer powers: adopted as the `controls` scope (cancel, restore, dates/priority, client/project).
- New-invite defaults: adopted (review ✗ for invites, ✓ migrated) with the "They'll be able to" sentence; §16 Q4.
- Roles page intro: adopted verbatim.
- Persona labels + title, owner marker: adopted.
- Editors seeing other editors on past/created jobs: adopted as the read cut-off (§2.3).
- Client-visible field labels and one-click preview/deliver: adopted (§11).
- Ask to share on Deliver: adopted inside the Deliver dialog. The per-client "share new jobs automatically" default was **rejected** for now: project-level sharing already covers "everything for this client project", and a third sharing switch would make "why can the client see this?" harder to answer.
- Turn feedback into a revision request: adopted (`client_feedback.to_revision`).
- Client email + invite hand-off: email **deferred** (§7.6, §16 Q5); Copy invite message adopted. An invite-link flow was rejected for this change (needs a token table and email to be useful).
- Rail tooltip / mobile drawer stacking: adopted (portal the tooltip; drawer confirmed as `<dialog>` in `app-shell.tsx`); e2e extended.
- Cancelled jobs in the portal: adopted as 30-day "Cancelled" visibility. A client notification for cancellation was **rejected** for now (cancellations are usually agreed with the client by phone; a notification can be added later as a fourth client type).
- Notification dedupe for owner-as-everything: adopted (test).

### Product review — spec gaps
- Job-creation interpretation: §15 + §16 Q1 (portal "Request a shoot" noted as a follow-up, not built).
- Editor private information: §2.4 (incl. whether ⚑teamJobs editors see the owner's shoots: yes while being edited; §16 Q6).
- Editor questions routing: §6.4 + `questions` widget.
- "Jobs assigned to editors": drill-down from `team_workload` rows (a separate list widget was rejected as duplicating Kanban's In editing column).
- Turnaround analytics: `turnaround` widget (§9).
- Historical workload: Performance → editor detail Workload history + Reports preset (§9).
- Org notification configuration: out of scope, stated (§6.3).
- Own vs assigned for members: §15 + `controls`.
- Agreed milestones, reopened jobs, jobs without shoot date: §7.4.
- "Approved finished-work links": defined as links the studio shares at or after delivery (§15, §7.3).
- Which surfaces force review duties: My Work and the review widgets (§8).
- Self-approval for photographers: explicit decision (§3.4, §15).

---

## Foundation implementation notes (package A + the H/F pieces the foundation brief assigned)

Recorded by the foundation pass; other packages build on these exact names.

- **Migration test file**: `src/db/migrations.roles.test.ts` (the brief's name) implements §12.1 `db/migrations.roles-v2.test.ts`. It boots PGlite at 0001 from a copied partial `drizzle/` folder, inserts v1 data (3 orgs incl. the inactive-owner and no-possible-admin cases), asserts the RAISE and the full rollback of 0002+0003 (one migrator transaction), fixes the data, re-migrates and asserts every mapping, event, CHECK, guard (31 row guards) and 0 drift.
- **Portal routes** live in `src/app/portal/` (per §7.7, not `(portal)/portal`): `layout.tsx` (placeholder header, `portalPageContext()`), `page.tsx` (placeholder "Your work"). Package G replaces both.
- **Transitional shims (remove when the last caller is ported; never widen)**: `isManagement` = `isAdmin` (deprecated alias in `permissions.ts`); `roleCanEver(role, action)` (deprecated; any persona of the role); `ROLE_LABELS` (deprecated, 3 roles); `managersOf` / `ownersOf` = `adminsOf` (deprecated, `services/notifications.ts`); `GUARD_MIGRATION_FILE` (deprecated). `MANAGEMENT_ROLES` is removed outright so every call site fails to compile until ported.
- **Sync job refs are conservative**: `jobRefFromRow(job, facts?)` (permissions.ts) defaults `draftClosed = true` and `projectSharedWithClient = false` when the facts are not loaded; `services/_shared.jobPermissionRef`, `queries/scope.permissionRefOf` delegate to it. Use `loadJobRef(db, ctx, jobId)` / `loadJobRefs` (`src/server/auth/job-ref.ts`, one query: row + project share + pastEditorIds + draftClosed) for every permission decision; `loadJobPermissionRef`, `loadVisibleJob`, `loadJobWithRef` already do.
- **Minimal service edits made by the foundation** (so the seed and runtime work against the new data; owners keep them): `createJob` stamps `created_by_role` + `metadata.creatorRole`; `addLink` stamps `added_by_sharer`; `notify()` applies the client-type hard filter (§6.2); `adminsOf` added and automation target `"admins"` resolved; `redactUser` uses `isAdmin`; `services/workflows.ts` template cancel edges use `CANCEL_EDGE_ROLES`; `src/lib/workflow.ts` edge role match (`edgeRolesAllow`, §5.2 step 3) and `TRANSITION_ROLES` validation (`actionsForMove` is still package B's).
- **Seed**: Harbourline Realty is excluded from the generic planner (`NorthlightRefs.excludeClientNames`); all its jobs are scripted in `src/db/seed/portal.ts` (`schedulePortalStory`), which also creates the six editor-created jobs. Sharing, portal switches, client users, client feedback, inline editor projects and editor self-assign/claim are direct trigger-safe writes + audit events in one transaction, each marked `TODO(roles-v2, package …)` with the service that replaces it. Scenario (§12) bucket checks in `seed/summary.ts` count planned jobs only; the roles-v2 hard checks of §13 are added.
- **`db:verify`** reports the seven §1.4 invariants as structural issues (`rolesV2Invariants`); an inactive default photographer is not reported (no warning channel in `IntegrityReport`).

## E2E implementation notes (package H, e2e)

- **Spec files** (the integration brief's names; they implement §12.2): `e2e/roles-owner.spec.ts` (= `roles-admin`), `e2e/roles-team-photographer.spec.ts` (= `roles-member`), `e2e/roles-editor.spec.ts`, `e2e/client-portal.spec.ts` (= `portal` + `portal-isolation`), `e2e/stacking.spec.ts` (the §11.1 regression, desktop 1280×800 and 390×844; kept out of `regression-shell.spec.ts`).
- **Accounts** (`e2e/api.ts` `Role` → `ROLE_EMAILS`): exactly the §12.2 keys. Fresh team members, editors and client users are invited per test (`Api.inviteUser(role, { flags, isAdmin, clientId })`), so a spec never depends on seeded switches it does not name. Each portal test builds its own client (`POST /api/clients/:id/portal`) and client user.
- **Ported**: `manager1@studio.test` → `photographer01@studio.test` on a job where they are the photographer (edge-cases conflicts: `controls` lets them re-date and cancel) or an invited team member (dashboard layout); the `system.integrity` 403 assertion now covers photographer01 and an editor.
- **Scope cookie hygiene**: `POST /api/me/scope` is only ever sent from disposable sessions (`apiAs`, a test's own browser context), never from the worker-scoped owner `api`, so no other spec runs in "My shoots".
- **Portal list shape**: `GET /api/portal/jobs` is read through `flattenPortalJobs` (accepts `PortalProjectGroup[]`, `PortalJob[]` or `{ groups | items | jobs }`); the detail projection is asserted against the exact §7.4 key set (`PORTAL_JOB_DETAIL_KEYS`).

## Package D notes: users / teams / settings / auth services

Recorded by the users-services pass. These refine the contract and do not change it.

- **422 errors**: the user-management 422s are `UserRuleError` (`services/_admin.ts`): HTTP 422, error `code` stays `"validation"`, and the machine reason is in `details.reason` ∈ `last_admin | primary_owner | role_change_not_allowed | admin_has_every_permission | flag_not_for_role | client_portal_off | not_staff | invalid_target`. Email collisions (invite **and** admin email change) are a 409 `ConflictError` with the §6.1 message, exported as `EMAIL_UNAVAILABLE_MESSAGE`.
- **Invite body**: the switches go in a nested `flags` object (`{ role: "photographer", isAdmin?, flags?: {…member switches} }`, `{ role: "editor", flags?: { canCreateJobs?, canViewTeamJobs? } }`, `{ role: "client", clientId, name, email, avatarColour? }`). Each variant is strict. The old top-level `canViewTeamWorkloads` / `canViewAnalytics` keys are rejected with 400. A client invite takes no title or capacity. Every switch column is written explicitly from the role's invite defaults, so a new invite never inherits the DDL default `can_review_submissions = true`. Clients get every switch false.
- **`session_version`** is bumped by `setAdmin` as well as by role change, deactivation and password reset. *(Integration change:* `setPermissions` no longer bumps it — contexts are rebuilt from the user row on every request, so a switch, granted or revoked, applies on the person's next request without signing them out on every device; see "Integration notes".)
- **Where the guards fire**: the primary owner is always an active admin (trigger), and the actor is a second active admin. So the service `last_admin` check can only fire for a request already in flight when the other admin left, or for an org without a primary owner (before the 0003 backfill). The tests cover both cases. The primary-owner 422 can only come from the trigger mapping; co-admins get 403 from the hard rule first. `guarded()` maps both trigger messages to the same 422s.
- **Role change** writes `user.role_changed` with `previousValue/newValue.isAdmin` and `metadata.flagsReset: { [flag]: { from, to } }` (only the new role's switches are reset). When an admin becomes an editor it also writes `user.admin_changed` (`metadata.reason = "role_changed"`). Deactivating an admin sets `metadata.adminCleared` on `user.deactivated`, plus `user.admin_changed` (`reason = "deactivated"`).
- **`setPermissions`** writes one `user.flags_changed` event that holds only the changed switches, plus `metadata.changedFlags`.
- **`transferPrimaryOwner`** lives in `services/users.ts`, and `expectedVersion` is the `organisation_settings.version`.
- **Client portal users**: `listClientPortalUsers(db, ctx, { clientId })` in `services/users.ts`, served at `GET /api/clients/:id/portal-users` (admin, `client.manage_portal`).
- **Notification prefs**: `getNotificationPrefs` lists only the types the user can receive. That is `CLIENT_NOTIFICATION_TYPES` for client users and every other type for staff. Setting a type outside that list is a 400.
- **Settings**: `defaultPhotographerUserId` can be edited through `PATCH /api/settings` (null, or an active photographer of the org; otherwise 422 `invalid_target`; foreign id 404). The event metadata carries `previousName` / `nextName`. `dismissRolesNotice` is served at `POST /api/settings/roles-notice/dismiss` (idempotent). The four deprecated visibility switches, `primaryOwnerUserId` and `rolesV2NoticeDismissedAt` are unknown keys and return 400.
- **Login**: when a client user has the portal off or the client is archived, the login also writes `auth.login_failed` (`reason = "portal_closed"`) and counts toward the rate limiter. The response is the same generic 401.
- **Teams**: a team member or lead who is a client user is rejected with 422 (`not_staff`).
- **Routes added**: `POST /api/users/:id/admin`, `POST /api/users/:id/permissions`, `POST /api/organisation/primary-owner`, `POST /api/settings/roles-notice/dismiss`, `GET /api/clients/:id/portal-users`. `/api/users/:id/visibility` is deleted (§6.1).

## Job / workflow / collaboration services notes (packages B + C)

- `actionsForMove(ctx, from, to, isReopen, job)` lives in `src/lib/workflow.ts` (with `canMakeMove`, `deniedMoveAction`; `actionForMove` is a deprecated primary-action shim). An admin's move to new/ready while an editor holds the job is labelled "Unassign editor" (never "Decline").
- Sharing writers are in `src/server/services/sharing.ts`: `shareJob`, `shareProject`, `shareLink`, `setClientPortal`, `runDeliveryStep` (called by `applyMove` on a delivering move), `resetSharingForClientChange` (called by `applyJobFieldChanges`). Schemas: `ShareJobInput`, `ClaimJobInput`, `DeliveryInput` (validation/jobs.ts), `ShareLinkInput` (validation/links.ts), `ShareProjectInput`, `SetClientPortalInput` (validation/sharing.ts).
- `createJob` creates the inline `newProject` itself (`project.create` with `inlineFromJobCreate`, event `project.created`) because `services/projects.createProject` checks `project.create` without a resource (editors denied). Package D may expose an inline option and jobs.ts can delegate.
- `applyJobFieldChanges` permission-checks only fields whose value actually changes (forms send every field; an unchanged date/project must not need `controls`).
- `addComment` / `editComment` / `deleteComment` accept client contexts (portal): the job is resolved through `portal.view_job` (404), a client may only start / reply in / edit / delete `client_feedback` in threads started by their own client (else 404).
- `workloadWatchersOf(db, orgId)` is implemented in `services/sweep.ts` (notifications.ts is not package B/C's file in this split).
- Editor read cut-off for `listComments` / `listNotes` / `listLinks` / `finishedWorkLinks` uses `editorReadCutoff` / `passesCutoff` / `loadEditorAssignmentFacts` from `queries/scope.ts` (package E).


## Read-side implementation notes (package E: `src/server/queries/**`)

Recorded by the read-side pass; routes and pages compile against these names.

- **View scope plumbing** (§8): queries never read cookies. List queries take the request's `?scope=` inside their input (`JobListFiltersSchema.scope`, also on Kanban / Calendar / Timeline / Activity schemas; `"all"` is accepted as an alias of `"business"`) and the cookie as an argument: `listJobs(db, ctx, input, { scopeCookie })`, `listJobsApi`, `getKanbanBoard`, `getCalendarEvents`, `getTimelineRows` (`ListScopeOptions`), `listActivity(db, ctx, input, { scopeCookie })`, `getDashboard(db, ctx, { scope, scopeCookie })`, `getKpis(db, ctx, { scope, scopeCookie })` (`ViewScopeOptions`). All resolve through `viewScopeFor()` (`queries/scope.ts`, = `resolveScopeFrom`), so non-holders are never narrowed or widened. Results carry the resolved `scope` (`JobListResult.scope`, `KanbanBoard.scope`, `DashboardData.scope`). **Routes must pass `scopeCookie: (await cookies()).get(VIEW_SCOPE_COOKIE)?.value`** — not wired yet (route owners).
- **Dashboard** (§9): `DashboardData.variant` is now `"business" | "personal"`; new fields `scope`, `myShoots`, `awaitingReview` / `questions` (`DashboardScopedList` with `moreInBusiness` for the "N more in Whole business →" footer), `upcomingDeadlines` (`DashboardDeadline`), `revisions`, `turnaround` (`TurnaroundSummary`, analytics only). Editors' KPIs and lists cover the jobs they hold ("✓ (assigned)"); `recentCompleted` = delivered + completed in the last 14 days. `services/dashboards.ts` `defaultLayoutFor(persona | role)` and `allowedWidgetTypes` follow the §9 table (minimal port by this pass).
- **`needsAdminReviewWhere()`** lives in `queries/scope.ts`: no active photographer who manages the job (photographer, or creator as a photographer) is an admin or has ⚑review. Used by My Work ("Reviews waiting for me", always) and by the admin's `awaiting_review` / `questions` in "mine" scope.
- **Editor read cut-off** (§2.3): `editorReadCutoff(ctx, ref, assignments)` (pure), `editorCutoffWhere(ctx, createdAtCol, authorCol)` (SQL, correlated on `jobs`), `passesCutoff`, `redactOtherEditor` / `ANOTHER_EDITOR` (`id: "another-editor"`). Applied in job detail (comments, notes, links, revisions, assignments, stages), job history (stages entered at/after the cut-off lose actor/holder), activity feeds, search hits, and every JobRow / calendar / timeline editor ref. Editors without ⚑teamJobs can filter/group by `editorId = "another-editor"` but never by another editor's id.
- **Private information** (§2.4): editors get clients' `contactName / email / phone = null` and no `notes` (list, detail; `q` = name only); assignment `reason` is nulled for editors unless they are the actor or subject (job detail + `metadata.reason` in feeds); note previews and note search follow `note.read` (members: `internal` only on managed jobs).
- **Activity feeds follow the same read rules** (`activityScopeWhere`, `queries/activity.ts` — every feed: global `/api/activity`, job Activity / History tabs, dashboard recent activity, CSV export): editors never receive `note.*` events whose snapshot kind is in `EDITOR_HIDDEN_NOTE_KINDS` (`NOTE_KIND_META.editorReadable = false`: `internal`, `client`); `work_session.*` events reach non-admins only for their own sessions (actor or `metadata.sessionUserId`) and, for members, on managed jobs (`timer.view_others`) — never another person's time for editors, ⚑teamJobs included.
- **Actor before version and state** (§5.2): every user status move (`transitionJobStatus`, the accept / decline / start / submit / … wrappers, reopen, restore, bulk, `requestRevision`) runs `assertMayMoveJob` (`job.transition` on the job) right after loading the job; `resolveRevision` checks `revision.resolve` first; `updateJob` / the single-field setters require at least one field action. A read-only viewer therefore gets 403 — never a 409 carrying the job row, nor a 422 about the job's state. `edgeDenialReason` checks the actor before `requiresAssignedEditor`, and `deniedError` reports the move's own action (e.g. `job.reopen`) before `editor_required`.
- **Users** (§3.4): non-admin lists use `StaffUserListFiltersSchema` (`role=client` → 400) and the reduced projection `reducedUser()` (`ReducedUser`, with `isPrimaryOwner` from `organisation_settings`); `getUserDetail` 404s client ids for non-admins; person pages use `canOpenPersonPage(ctx, target, "workload" | "performance")` / `assertPersonPage` (`queries/workloads.ts`) for `getWorkloadDetail`, `getUserCompletedWork`, `getEditorAnalytics`. `DirectoryStats.completedThisMonth` is nullable (§10.2).
- **Options** (§3.4): `getClientOptions` / `getProjectOptions` are standalone queries (every non-archived client / project for anyone who can `job.create`, else the `client.view` / `project.view` scope); `getUserOptions` allows `role=photographer` to creators, requires `comment.mention` for `jobId`, and never lists client users to non-admins.
- **Client isolation**: every staff query either 403s a client context (`assertCan` on its action, or `assertStaffRead()` = `app.access`, used by dashboard, options, Team Work, job types) or returns nothing through `visibleJobsWhere`; `metrics.scopeWhere(ctx, "org")` returns no rows for a client context as a backstop. Staff notification lists exclude `CLIENT_NOTIFICATION_TYPES`; notification prefs list only the persona's types.
- `queries/portal.ts` was written by the portal package (G); the read-side pass reviewed it and did not change it.

## Integration notes (integrator pass)

Decisions and fixes made while wiring the packages together; each has a test or an e2e/curl check.

- **Permission switches no longer sign people out.** `setPermissions` does not bump `session_version` (package D bumped it). Contexts are rebuilt from the user row on every request, so a switch (granted or revoked) applies on the person's next request; forcing a sign-out on every device each time the owner adjusts a switch added friction without adding security. `setAdmin`, role change, deactivation and password reset still bump it. `users.test.ts` now asserts the old session stays valid and carries the new switches.
- **Rule violations are 422, not 400.** New `RuleViolationError` (`src/server/errors.ts`, a `ValidationError` with status 422 so forms map field errors the same way) for: allow-list targets (photographer / editor / revision assignee of the wrong role or deactivated: `jobs.ts`, `assignments.ts`, `workflow.ts`), client-thread kind rules and @mentions in client threads (`comments.ts` `ThreadKindError`), and a delivery payload on a non-delivering move. This is what §3.3 ‡, §3.4 and §7.3 say; the package tests that asserted 400 for these exact cases were updated to 422 (no assertion removed).
- **Editor draft links.** `link.add` for an editor combined `working` and `draft` with "first match wins", so a self-assigned draft job ("Assign to me", still assigned/accepted) refused the `raw_files` source link. The scopes now combine (`permissions.ts`; new cases in `permissions.test.ts`).
- **Deliver dialog built** (§7.3, §11): `src/components/jobs/deliver-dialog.tsx`, wired through `useJobActionController` (`deliver` context) — the header's delivering move reads **"Deliver…"** and opens it when the client has the portal on. Pre-selection = gallery / client-delivery links, else finished files (`defaultDeliverySelection` in `src/lib/sharing.ts`, unit-tested); "Share this job with {client} now"; "Added after approval" flags; "The client will see Delivered with nothing to open" + "Deliver without links". Kanban / bulk / automations keep the server default set.
- **"Your studio owner reviews this job"** hint (§4.4) on the job header for team members without Review submissions while the job is in a reviewer stage.
- **Scope cookie wired** into `GET /api/jobs|kanban|calendar|timeline|activity|dashboard` (`src/app/api/_lib/scope.ts`); `/api/dashboard` also takes `?scope=`.
- **Real 403s**: `/team/photographers` and `/team/editors` gate `team.view_members` in a `layout.tsx` (was inside the page, under the loading boundary → 200); `/team/users/[id]` applies the §3.4 person-page rule (`canOpenPersonPage`) in its layout — `user.view` alone let editors and members without the switches open any person page. `GET /api/team-work` uses the Team Work page gate (§10.1).
- **`GET /api/portal/notifications`** returns `{ items, nextCursor }` like the staff list (was a bare array).
- **Topbar**: with the scope switch present, the account button shows the name only from `xl` (6 px horizontal overflow at 768 / 1024 otherwise). Rail tooltips show on keyboard focus only (`:focus-visible`), so a mouse click on the collapse toggle no longer leaves a second tooltip up.
- **Build**: the scope switch hook read `useSearchParams()` during render, which broke `next build` on the statically prerendered `/design-system`; it now reads `window.location` at click time.
- **Job detail page** builds its permission ref with `loadJobRef` (was hand-built and compared roles to owner/manager); the comments tab labels `client_feedback` threads and leaves replies to the Client access card.
- **E2E locators** (product unchanged): `roles-owner` scope UI test matches the accessible row link (All Work also renders a CSS-hidden card list); `roles-team-photographer` matches the header's exact "Edit" link (the sidebar's "Editors" link matched `/^Edit/`).
