# Architecture — Photographer Work Management Platform

**Status: source of truth.** Every build agent works from this document. Names here (tables, columns, enums, actions, event types, routes, modules) are the names in `src/db/schema.ts` and `src/lib/constants.ts`; if the two ever disagree, the code wins and this file must be fixed in the same PR.

Stack (fixed, see `CLAUDE.md`): Next.js 16.4 App Router · TypeScript strict · Drizzle ORM (`drizzle-orm/pg-core`) on Postgres — Supabase (postgres-js) in production, PGlite locally/in tests; all DB access is async (`docs/POSTGRES-MIGRATION.md`) · Zod 4 · jose · bcryptjs · nanoid.

---

## 0. Design principles

1. **Ledger vs state.** Ledgers are append-only or *fill-once* tables: `activity_events`, `job_status_transitions`, `job_assignments`, `job_revisions`, `job_links`, `job_comments`, `work_sessions`, `automation_runs`, `notifications`, `team_memberships`. State tables (`jobs`, `users`, …) carry denormalised *pointer* columns for fast reads; every pointer is re-derivable from a ledger and checked by `npm run db:verify` (detects) / `recomputeJobDerived()` (repairs).
2. **Immutability at three layers.** (a) no service code path updates/deletes ledger rows; (b) a vitest source-grep fails the build if `update(activityEvents` / `delete(<ledger>` appears in `src/`; (c) PL/pgSQL triggers (`drizzle/0001_guards.sql`) `RAISE EXCEPTION` at the DB level. `activity_events` has **no `updated_at` column**.
3. **One transaction per mutation**, with the `activity_events` row written inside it. A mutation and its evidence can never diverge.
4. **No hard deletes.** Users are deactivated (or anonymised), jobs cancelled, everything else archived. `jobs` and `users` have DELETE triggers.
5. **Semantic categories, not names.** Every workflow status maps to one of 13 `StatusCategory` values; KPIs, kanban, permissions, metrics and automations key on the category so custom workflows cannot bypass anything by renaming.
6. **Org isolation by construction.** Every tenant table carries `organisation_id`; loaders return **404 (never 403)** for ids outside the actor's organisation; `visibleJobsWhere(ctx)` is the single row-level predicate every read starts from.
7. **Time in stage is a first-class record.** `job_status_transitions` has `entered_at`/`exited_at`, exactly one open row per job, categories and status name snapshotted, and the editor who held the job in that stage. Reassignment mid-stage *re-attributes* the stage (closes and reopens the row) without changing status.
8. **Metrics are pure functions over ledgers.** On-time % uses the due date in force at approval (`jobs.due_date_at_approval`), never the current one.
9. **Optimistic concurrency** via `version` columns (409 with the current row) and **immediate revocation** via `users.session_version`.
10. **Seed drives the real services under a fake clock**, so demo history satisfies production invariants, and `db:verify` must pass before the seed exits.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Ids | `nanoid()` 21 chars via `$defaultFn`; services may pre-generate (`src/lib/ids.ts → newId()`) when a row must reference itself (comments `root_comment_id`). |
| Job numbers | `PJ-0001`: `UPDATE organisations SET job_sequence = job_sequence + 1 WHERE id = ? RETURNING job_sequence` inside the create transaction; prefix from `organisation_settings.job_number_prefix`; padded to 4 (`JOB_NUMBER_PAD`), grows past 9999 naturally. `UNIQUE(organisation_id, job_number)`. |
| Timestamps | ISO-8601 UTC `text` (`2026-10-08T03:12:45.123Z`), produced by `ctx.now()` (`src/server/clock.ts`), **never** by DB defaults in services (the `$defaultFn` defaults are a safety net for scripts/tests only). |
| Calendar deadlines | `shoot_date`, `due_date`, `review_due_date`, `delivery_due_date`, `job_revisions.due_date`, `projects.start_date/end_date` are ISO UTC instants. The UI picks a civil date and the service stores **end of that day in the organisation timezone** (`endOfCivilDayIso` in `src/lib/dates.ts` = the *last millisecond* of the civil day, e.g. `2026-10-09` in Sydney → `2026-10-09T12:59:59.999Z`; compare with `<=`, and use `startOfCivilDayIso(addCivilDays(d, 1))` for an exclusive bound). "Due today", "overdue", "days remaining" use `civilDate()/daysRemaining()` in org tz. |
| Booleans / JSON | `boolean()`; `jsonb().$type<T>()`. Every JSON column has a Zod schema in `src/lib/validation/json.ts` applied on write and on read (parse-or-fallback with a logged warning). |
| DB access | Async everywhere: `await db.transaction(async (tx) => …)` via `withTx` (one transaction per mutation + its audit events; external notification channels run in `afterCommit`), every query awaited, `first(q)` / `one(q)` instead of `.get()`. Same code on both drivers (`src/db/index.ts`): postgres-js (`DATABASE_URL`, `prepare: false`) or PGlite. int8/numeric are parsed to JS numbers on both. Case-insensitive search uses `ILIKE`; name sorts use `COLLATE "C"` so PGlite (C) and Supabase (en_US) order identically. Insertion-order tie-breaks use the `rowid` identity column (§2.7). |
| FKs | all `onDelete: "restrict"` (Postgres enforces them; isolation READ COMMITTED + optimistic `version` checks). |
| Naming | DB `snake_case`, TS `camelCase`. Column `*At` = instant; `*Id` = FK. |
| Errors | `src/server/errors.ts`: `ValidationError(400)`, `UnauthorizedError(401)`, `ForbiddenError(403, action)`, `NotFoundError(404)`, `ConflictError(409, current)`, `InvalidTransitionError(422, from, to)`, `RateLimitedError(429)`. Route handlers map them via `handle()` in `src/server/http.ts`; unknown errors → 500 with `requestId`, never a stack. |
| Validation | Services parse `unknown` input with Zod (`src/lib/validation/*`); route handlers/server actions never validate themselves. |

---

## 2. Data model

27 tables. `src/db/schema.ts` is authoritative; this section explains purpose and the columns that carry invariants.

### 2.1 Tenancy & people

> Roles v2: `users.role` ∈ photographer / editor / client, plus `is_admin`, the permission switches and `client_id` — see `docs/ROLES.md` §1.

| Table | Purpose | Key columns / invariants |
|---|---|---|
| `organisations` | Tenant. | `slug` unique; `job_sequence` gap-free allocator. |
| `organisation_settings` | One row per org (PK = `organisation_id`). Thresholds, flags, SLA. | `timezone`, `week_starts_on`, `job_number_prefix`, `time_tracking_enabled`, `work_session_auto_timeout_minutes`, `default_capacity_hours_per_week`, `default_estimated_hours`, `workload_near_capacity_ratio` (0.7), `workload_overloaded_ratio` (1.0), `max_active_jobs_per_editor` (12), `review_bottleneck_hours` (24), `review_bottleneck_min_jobs` (3), `editing_bottleneck_due_within_hours` (48), `editing_bottleneck_min_due_soon` (3), `unassigned_backlog_min` (10), `stalled_days` (5), `revision_spike_min_count` (5), `revision_spike_multiplier` (1.5), `review_sla_hours` (24), `photographers_see_all_jobs`, `photographers_see_team_jobs`, `editors_see_team_jobs`, `editors_see_team_workloads`, `automations_enabled` (kill switch), `audit_notifications`, `last_overdue_sweep_at`, `version`. |
| `users` | People. Never deleted. | `email` globally unique (login); `role` ∈ ROLES; `is_active`, `deactivated_at/by`, `anonymised_at`; `capacity_hours_per_week` (null → org default); `can_view_team_workloads`, `can_view_analytics` (per-user flags, photographers); `session_version` (bump → all cookies invalid); `version`. |
| `user_notification_prefs` | Per-type in-app toggles. Missing row = enabled. | `UNIQUE(user_id, type)`; mandatory types (`NOTIFICATION_TYPE_META[type].mandatory`) ignore prefs. |
| `teams` | Named groups for visibility & workloads. | `UNIQUE(org, name)`, `lead_user_id`, `archived_at`. |
| `team_memberships` | **Ledger.** Membership intervals. | partial unique `(team_id, user_id) WHERE left_at IS NULL`; `left_at` fill-once. "Active teammates of U" = users sharing a team membership row with `left_at IS NULL` and team not archived. |

### 2.2 Production structure

| Table | Purpose | Key columns |
|---|---|---|
| `clients` | Agencies, couples, brands. | `archived_at`, `created_by_user_id`, `version`. |
| `projects` | Client → Project (e.g. "123 Smith Street"). | `client_id` NOT NULL; `archived_at`; `version`. |
| `workflows` | Per-org status graphs. | partial unique one `is_default` per org; `archived_at`. |
| `workflow_statuses` | Named statuses with a semantic `category`. | `key` stable slug (`UNIQUE(workflow_id, key)`), `name` unique among non-archived, `category` ∈ STATUS_CATEGORIES, `sort_order`, exactly one `is_initial` per workflow, `archived_at` (never deleted: history references them). |
| `workflow_transitions` | Explicit edge table per workflow. | `UNIQUE(from_status_id, to_status_id)`; `allowed_roles` JSON `Role[]`; `requires_assigned_editor`; `assignee_only` (editor must be the current editor); `is_reopen`; `archived_at`. The seed generates a `→ cancelled` edge for every active status; restore-from-cancelled needs no edge (engine computes the target, §4.5). |
| `job_types` | Admin-created types, each bound to a workflow. | `workflow_id`, `default_estimated_hours`, `archived_at`. |

### 2.3 Jobs (state table)

`jobs` columns grouped by who writes them:

| Group | Columns | Written by | Derivation (db:verify) |
|---|---|---|---|
| Identity | `job_number`, `name`, `description`, `client_id`, `project_id`, `job_type_id`, `workflow_id` (snapshot at creation), `priority`, `created_by_user_id` | `jobs` service | `client_id` **must equal** `projects.client_id` (trigger `jobs_client_matches_project_*`; `updateJob` re-syncs it when the project changes). |
| Workflow state | `status_id`, `status_category`, `previous_status_id`, `status_entered_at` | **only** `transitionJobStatus()` | = open `job_status_transitions` row (`to_status_id`, `to_category`, `from_status_id`, `entered_at`). Triggers: `status_id` must belong to `workflow_id`, `status_category` must equal the status's category, and **`status_id` may only change once the open transition row with that `to_status_id` exists** (`jobs_status_change_needs_transition`). Order inside the tx is therefore: close old transition → insert new transition → update `jobs`. |
| People | `photographer_id`, `editor_id`, `previous_editor_id` | **only** the assignment service | = open `job_assignments` row per role; `previous_editor_id` = `user_id` of the most recently closed editor assignment. |
| Dates | `shoot_date`, `due_date` (editing deadline → Overdue/Due Today), `review_due_date` (reviewer deadline → calendar + `review_overdue` bottleneck/notification, **never** in the Overdue KPI), `delivery_due_date` (calendar/filters only) | `jobs` service | — (each change is its own event). |
| Effort | `estimated_hours`, `completion_percent`, `is_paused`, `paused_at` | jobs/workflow services | `is_paused` only true in `CATEGORY_GROUPS.EDITOR_WORKING`; transitions clear it. |
| Revisions | `revision_count`, `open_revision_id` | workflow service | `revision_count = MAX(job_revisions.revision_number)`; `open_revision_id` = the row with `resolved_at IS NULL` (≤ 1 by partial unique). |
| Milestones | `started_at` (first in_progress entry), `first_submitted_at`, `last_submitted_at`, `approved_at`, `approved_by_user_id`, `due_date_at_approval`, `delivered_at`, `completed_at`, `due_date_at_completion`, `was_on_time`, `cancelled_at`, `reopened_count` | `transitionJobStatus()` | `completed_at`/`cancelled_at` reflect **only the currently open terminal stage** (null after reopen/restore); `approved_at/delivered_at` = latest entry into that category since the last reopen (null after reopen); `started_at/first_submitted_at` are first-ever and survive reopen; `reopened_count` = count of transitions with `is_reopen`. |
| Activity | `last_activity_at` | `recordEvent()` (no version bump) | `= MAX(activity_events.created_at) WHERE job_id`. |
| Concurrency | `version` | every job mutation (`UPDATE … WHERE version = ?` → 0 rows = 409) | — |

Indexes: `(org, job_number)` unique; `(org, status_category, due_date)`; `(org, editor_id, status_category)`; `(org, photographer_id, status_category)`; `(org, status_id)`; `(org, completed_at)`; `(org, shoot_date)`; `(org, review_due_date)`; `(org, delivery_due_date)`; `(org, project_id)`; `(org, client_id)`; `(org, last_activity_at)`; `(org, created_by_user_id)`.

### 2.4 Job ledgers

| Table | Purpose | Key columns / invariants |
|---|---|---|
| `job_assignments` | Who held which role, when. | partial unique `(job_id, role) WHERE unassigned_at IS NULL`; `assigned_by_user_id` null = automation; `status_category_at_assign`; fill-once `unassigned_at`, `unassigned_by_user_id`, `unassign_reason` ∈ UNASSIGN_REASONS; `activity_event_id` provenance. |
| `job_status_transitions` | Stage occupancy intervals (time-in-stage). | `sequence` contiguous (`UNIQUE(job_id, sequence)`); `kind` ∈ `creation \| transition \| reattribution \| migration`; `from_status_id/to_status_id` + snapshots `from_category/to_category/status_name`; `actor_user_id` null = system; `automation_run_id`; `reason`; `is_reopen`, `is_override`; `entered_at`; fill-once `exited_at` + `duration_seconds`; `editor_id_at_entry`, `photographer_id_at_entry`; partial unique one open row per job. |
| `job_revisions` | Numbered revision requests. | `UNIQUE(job_id, revision_number)`; ≤1 open (`resolved_at IS NULL`); `reason` free text (chips in `REVISION_REASON_SUGGESTIONS`), `description`, `instructions`, `priority`, `due_date`, `assignee_user_id`; `request_transition_id`; fill-once `resolved_at`, `resolved_by_user_id`, `resolution` ∈ `resubmitted \| withdrawn \| approved \| cancelled`, `resolution_note`, `resolve_transition_id`. While open, `assignee_user_id/instructions/priority/due_date` may be edited (audited `revision.updated`). The open revision's assignee **is** the job's editor: naming another editor (`PATCH /api/revisions/:id`) reassigns the job via `assignEditorToJob` (permission `job.assign_editor`, like the request path). |
| `job_comments` | Threaded comments. Permanent. | `parent_comment_id`, `root_comment_id` (= own id for roots; set at insert, immutable), `revision_id` (respond-to-revision), `kind` ∈ COMMENT_KINDS, `body`; edits allowed only by the author within `COMMENT_EDIT_WINDOW_MINUTES` (15) and must set `edited_at` + bump `edit_count` (trigger); soft delete `deleted_at/by` fill-once, body retained. |
| `comment_mentions` | One row per @mention. | `UNIQUE(comment_id, mentioned_user_id)`; indexed by user for "mentions of me". |
| `job_notes` | Structured notes by kind. Editable in place. | `kind` ∈ NOTE_KINDS; `revision_id` when kind = revision; `last_edited_by_user_id`, `edit_count`; `is_pinned`; `archived_at/by`; `version`. Prior bodies live in `note.edited` events (previous/new); the Notes tab shows "edited N times" and a history drawer that reads those events. |
| `job_links` | External URLs as a supersession chain. | `kind` ∈ LINK_KINDS; `url` (http/https only), `label`, `provider` (derived from host); `supersedes_link_id` (unique) / fill-once `superseded_at` + `superseded_by_link_id` (unique) on the OLD row; fill-once `removed_at/by/reason`. **Current** = `superseded_at IS NULL AND removed_at IS NULL`. A slot's history = walk `supersedes_link_id`. Changing a link's kind/label (`updateLink`, `PATCH /api/links/:id`) is also a supersession (new row, same URL, event `link.updated`) because link content is immutable (`jl_fill_once`); a slot is filed under its current row's kind. |
| `work_sessions` | Timer intervals (time tracking). | one running timer per user (partial unique `user_id WHERE ended_at IS NULL`); `status_id_at_start`, `category_at_start`, `transition_id` (the stage it ran in); fill-once `ended_at`, `end_reason` ∈ SESSION_END_REASONS, `duration_seconds`. |

### 2.5 Audit, notifications, automations, personalisation

| Table | Purpose | Key columns / invariants |
|---|---|---|
| `activity_events` | **Append-only** audit log (§5). No `updated_at`. | `actor_user_id` (null = system), `automation_run_id`, `job_id` (null for non-job entities), `entity_type` ∈ ENTITY_TYPES, `entity_id`, `event_type` ∈ EVENT_TYPES, `action` ∈ EVENT_ACTIONS, `previous_value`/`new_value` JSON, `metadata` JSON (`{}` default), `summary` (frozen, actor-less), `visibility` ∈ `all \| management`. Read order is `(created_at, rowid)`: events written in the same millisecond keep insertion order (ids are random). |
| `notifications` | In-app notification centre. | `type` ∈ NOTIFICATION_TYPES, `title`, `body`, `link_path`, `job_id`, `actor_user_id`, `activity_event_id`; dedupe: unique `(user_id, activity_event_id, type)` and unique `(user_id, dedupe_key)`; only `read_at` may change. |
| `automations` | Rules. | `trigger_type` (indexed copy of `trigger.type`), `trigger`/`conditions`/`actions` JSON (`AutomationTrigger`, `AutomationCondition[]`, `AutomationAction[]`), `is_enabled`, `archived_at`, `version`. |
| `automation_runs` | **Ledger** of rule executions. | `UNIQUE(automation_id, trigger_event_id)` (a rule fires once per causing event); `depth` (0 human-caused, ≤ `AUTOMATION_MAX_DEPTH`=3); `status` ∈ `pending \| matched \| skipped \| succeeded \| failed`; `conditions_snapshot`, `actions_performed` JSON; `error`; `started_at`, `finished_at`. Identity immutable; finished runs frozen. |
| `saved_views` | Per-user / shared table configs. | `scope` ∈ SAVED_VIEW_SCOPES, `config` JSON `SavedViewConfig`, `is_shared` (managers+ only), `is_default`, `archived_at`, `version`. |
| `dashboard_layouts` | One per user. | `layout` JSON `DashboardLayout`, `version`. |

### 2.6 JSON columns (complete list)

`workflow_transitions.allowed_roles: Role[]` · `activity_events.previous_value/new_value: Json` · `activity_events.metadata: Record<string, Json>` · `automations.trigger: AutomationTrigger` · `automations.conditions: AutomationCondition[]` · `automations.actions: AutomationAction[]` · `automation_runs.conditions_snapshot: AutomationCondition[]` · `automation_runs.actions_performed: AutomationActionResult[]` · `saved_views.config: SavedViewConfig` · `dashboard_layouts.layout: DashboardLayout`.

### 2.7 DB triggers (`drizzle/0001_guards.sql` + `drizzle/0003_roles_v2_data.sql`, 31 PL/pgSQL row triggers (28 + users_keep_admin, users_client_link, org_primary_owner) + 12 TRUNCATE guards, idempotent DROP+CREATE)

Append-only: `activity_events` (no UPDATE/DELETE). No DELETE + fill-once guards: `job_status_transitions`, `job_assignments`, `job_revisions`, `job_links`, `job_comments`, `work_sessions`, `automation_runs`, `notifications`, `team_memberships`. No DELETE: `jobs`, `users`. Consistency on `jobs`: status ∈ workflow, category matches status, client matches project, status change requires open transition row, org/job_number/creator immutable. Installed by every migrate: PGlite auto-migrate on open (`src/db/index.ts`), `makeTestDb()`, `npm run db:migrate`, `db:migrate:remote` / `vercel-build`. `src/db/guard.ts` only lists them. Insertion order for same-millisecond ties uses the `rowid` identity column on `activity_events`, `job_assignments`, `automation_runs`.

### 2.8 `db:verify` and `recomputeJobDerived`

`src/db/verify.ts` (`npm run db:verify`, `GET /api/system/integrity`, end of seed, CI) recomputes every column in §2.3 "Derivation" plus structural checks: exactly one open transition per job; `sequence` contiguous from 1; each transition's `entered_at ≥` previous `exited_at`; every `kind='transition'` row has a `job.status_changed` event with `metadata.transitionId`; every revision has a `revision.requested` event; no open work session on a job in `TERMINAL`; no open assignment for an inactive user unless flagged (the editor's latest `user.deactivated` lists the job as `kept`); the open revision's `assignee_user_id` = `jobs.editor_id` when both are set (`open_revision_assignee_is_editor`); `open_revision_id` consistent; `revision_count` consistent. Returns `IntegrityReport` (`src/lib/types.ts`). `recomputeJobDerived(tx, jobId)` in `src/server/services/jobs.ts` rewrites the derived columns from the ledgers (used by seed assertions and the owner-only repair action; it is audited as `job.field_changed` with `metadata.cause = "recompute"`).

---

## 3. Permissions

> **The contract is `docs/ROLES.md` (roles v2).** This section is a summary; where anything here or in §2.1, §4.2, §6, §10, §12 disagrees with ROLES.md, ROLES.md wins.

### 3.1 Model (roles v2)

- **Exactly three roles** (`users.role`, `ROLES` in `src/lib/constants.ts`): `photographer`, `editor`, `client`. There is no owner or manager role.
- **Admin is a property of a photographer** (`users.is_admin`). The **persona** is derived, never stored (`personaOfUser`, `personaOf(ctx)`):
  - `admin` = photographer ∧ is_admin — shown as **Owner / Photographer**; complete visibility and administrative control.
  - `member` = photographer ∧ ¬is_admin — **Photographer (team member)**; six permission switches (§2.2 of ROLES.md).
  - `editor` — **Editor**; two switches (create jobs, see other editors' jobs).
  - `client` — **Client**; portal only (`/portal`, `/api/portal/*`).
- **Primary owner** (`organisation_settings.primary_owner_user_id`): the one admin other admins cannot demote, deactivate, re-role, re-email or reset; only they can transfer the status (`POST /api/organisation/primary-owner`). Last-admin and primary-owner rules are enforced by the services (friendly 422) and by DB triggers (`drizzle/0003_roles_v2_data.sql`).
- **Switches** are per user columns, read through the effective flags on `AuthContext` (`canCreateJobs`, `canViewAllJobs`, `canAssignEditors`, `canReviewSubmissions`, `canViewTeamWorkloads`, `canViewAnalytics`, `canViewTeamJobs`); admins get every member flag, clients none. The four old org-level visibility switches are deprecated columns, never read.
- `src/lib/constants.ts → PERMISSIONS: Record<Action, readonly Persona[]>` (who can ever do it; `personaMayEver`). `src/server/auth/permissions.ts → POLICY` (`satisfies PolicyTable`): one `Rule { label, scope, memberFlag?, editorFlag?, allow }` per action. `can()` / `assertCan()` apply the hard rules in order: inactive → other org → system allowlist → no user → persona → **self-review** (nobody reviews/approves/delivers a job they edited) → **primary-owner protection** → the rule. `permissionMatrix()` renders the Roles page.
- **Refs**: always build job refs with `loadJobRef` / `loadJobRefs` (`src/server/auth/job-ref.ts`: one query for past editors, the editor draft window `draftClosed`, and project sharing). `jobRefFromRow` without facts is deliberately conservative (draft closed, project not shared).
- **SQL twins**: `visibleJobsWhere(ctx)` (staff; clients get no rows), `managedJobsWhere(ctx)`, `portalJobsWhere(ctx)` (clients: shared jobs of their own client, cancelled ones for 30 days). `canViewJob` is the pure twin of `visibleJobsWhere` (property-tested in `visibleJobs.pg.test.ts`).
- **Gates**: `requireContext()` = staff only (`app.access`; a client gets 403 "This area is for studio staff"); `requirePortalContext()` = clients only (`portal.access`); `requireAnyContext()` only for `/api/auth/me|logout|change-password`. Pages use `pageContext()` (clients → `/portal`) and `portalPageContext()` (staff → `homePathFor(ctx)`: `/home`, editors `/my-jobs`). Missing **or foreign** ids are 404, never 403.
- **Personal vs business view**: REMOVED from the product (SIMPLIFICATION-PLAN §8). The owner always sees everything; an extra photographer sees only their own shoots because `visibleJobsWhere` says so, not because of a switch. `POST /api/me/scope` answers 404; the `pwm_scope` cookie is no longer written. The resolver (`src/server/view-scope.ts`, `viewScopeFor`) stays for the Advanced Board / Timeline pages and never widens anything.

### 3.2 Matrix (summary — the full per-action matrix is ROLES.md §3.3)

Legend: ✅ always · 🔸 condition · ❌ never. A admin (Owner / Photographer) · M team member · E editor · C client. ⚑ = needs that switch.

| Area | A | M | E | C |
|---|---|---|---|---|
| Use the studio app (`app.access`) / the portal (`portal.access`) | app | app | app | portal |
| Create jobs | ✅ any photographer | 🔸 ⚑create; photographer = self | 🔸 ⚑create; photographer required (default photographer → primary owner); editor = self or none; inline new project | ❌ |
| See jobs | ✅ all | 🔸 managed (photographer of / created) ∨ ⚑all | 🔸 assigned ∨ past ∨ created ∨ ⚑teamJobs (read-only, read cut-off) | 🔸 shared with their client (portal) |
| Edit fields / dates / priority / client | ✅ | 🔸 managed (dates, cancel, client: jobs they control) | 🔸 own draft window only | ❌ |
| Assign / reassign / unassign editors | ✅ | 🔸 managed ∧ ⚑assign | ❌ (self-assign at creation / claim only) | ❌ |
| Accept / start / submit / resubmit | ✅ on behalf | ❌ | 🔸 assigned | ❌ |
| Review, request revision, approve, deliver, complete, reopen | ✅ (never on a job they edited) | 🔸 managed ∧ ⚑review | ❌ | ❌ |
| Share jobs / links with the client, reply to client feedback | ✅ | 🔸 managed ∧ ⚑review | ❌ (read client threads) | 🔸 feedback on shared jobs when enabled |
| Share whole projects, client portal switches, invite client users | ✅ | ❌ | ❌ | ❌ |
| Team workload / analytics, reports, CSV, performance | ✅ | 🔸 ⚑workloads / ⚑analytics | own only | ❌ |
| Directories (Photographers / Editors) | ✅ | ✅ | ❌ | ❌ |
| Users, roles, permissions, settings, workflows, automations, teams | ✅ (primary owner protected) | ❌ | ❌ | ❌ |
| Audit / activity | ✅ incl. management events | 🔸 visible jobs | 🔸 visible jobs, read cut-off | ❌ |

Rules not expressible as cells (ROLES.md §3.4): allow-list target validation (editors for `assign_editor`, active photographers for photographer pickers, staff for mentions/teams/automation targets); reduced user projection for non-admins (`id, name, title, role, isAdmin, isPrimaryOwner, avatarColour, isActive`; never client users); person pages (`/team/users/[id]`) for admins, self, and members with ⚑workloads/⚑analytics; editors never see client contact details, internal/client notes, others' workloads or assignment reasons (ROLES.md §2.4); sharing/portal columns are written only by `services/sharing.ts` and the user services (every generic input schema is strict).

### 3.3 Security hygiene (`src/server/auth/*`, `src/server/http.ts`)

Stateless jose HS256 cookie `pwm_session` (`{ sub, sv, k }`, httpOnly, sameSite=lax, secure in prod, 30-day sliding — re-issued by `src/proxy.ts` once older than 24 h, see docs/ACCOUNTS.md; `k` = `staff` | `client`). The context is rebuilt from the user row every request; inactive, `sessionVersion` mismatch, or a client whose portal is off / client archived ⇒ 401. `sessionVersion++` on deactivate, role change, admin grant/revoke, password change, "Sign out of other devices" and logout (permission switches apply on the next request without a sign-out) (logout revokes every cookie issued before it, not just the browser's — except in the demo studio, where it only clears this browser's cookie). `src/proxy.ts` (no DB, unverified `k` claim, UX only) redirects cookie-less requests to `/login`, client cookies on staff pages to `/portal` and staff cookies on `/portal*` to their landing page (`/home` or `/my-jobs`); `/`, `/login`, `/signup` and the public link pages (`PUBLIC_PREFIXES`) are open to everyone, signed in or not, and only GET / HEAD responses outside `/api/auth/*` carry a renewed cookie; security lives in `requireContext` / `requirePortalContext` and the page layouts. CSRF: non-GET requests must carry an `Origin` whose host equals the request host. Login: bcrypt cost 12, Postgres-backed rate limits (`auth_rate_limits`, `src/server/auth/db-rate-limit.ts`: 5 failures / 15 min per email+IP and 20 per email), failures audited (`auth.login_failed`, never the password). URLs: `http:`/`https:` only (`ALLOWED_URL_PROTOCOLS`). `redact()` strips `passwordHash` from every event snapshot. 404 for foreign ids. Reduced projections for non-admins. Login failures for wrong passwords, inactive accounts and closed client portals are one generic 401 (no oracle).

---

## 4. Workflow engine (`src/server/services/workflow.ts`, pure graph helpers in `src/lib/workflow.ts`)

### 4.1 Default workflow — `DEFAULT_WORKFLOW_STATUSES`

| # | key | Name | category | Kanban column | KPI bucket | open | done |
|---|---|---|---|---|---|---|---|
| 1 | new | New (initial) | new | New | Unassigned | ✓ | |
| 2 | ready | Ready for Assignment | ready | New | Unassigned | ✓ | |
| 3 | assigned | Assigned | assigned | Assigned | Awaiting Editor | ✓ | |
| 4 | accepted | Accepted | accepted | Assigned | Awaiting Editor | ✓ | |
| 5 | in_progress | In Progress | in_progress | In Progress | In Editing | ✓ | |
| 6 | submitted | Submitted for Review | submitted | Review | Awaiting Review | ✓ | |
| 7 | review | Review Required | review | Review | Awaiting Review | ✓ | |
| 8 | revision | Revision Required | revision | Revision | Revision Required | ✓ | |
| 9 | resubmitted | Resubmitted | resubmitted | Review | Awaiting Review | ✓ | |
| 10 | approved | Approved | approved | Approved | Approved | ✓ | ✓ |
| 11 | delivered | Delivered | delivered | Approved | Approved | ✓ | ✓ |
| 12 | completed | Completed | completed | Completed | Completed | | ✓ |
| 13 | cancelled | Cancelled | cancelled | hidden | — | | |

Groups (`CATEGORY_GROUPS`): `ACTIVE` = open; `TERMINAL` = {completed, cancelled}; `DONE` = {approved, delivered, completed}; `DEADLINE_BOUND` = open ∧ ¬done (the only jobs that can be Overdue/Due Today); `EDITOR_HOLDS` = {assigned, accepted, in_progress, revision}; `REVIEWER_HOLDS` = {submitted, review, resubmitted}; `AWAITING_EDITOR` = {assigned, accepted}; `UNASSIGNED` = {new, ready}; `WORKLOAD` = EDITOR_HOLDS ∪ REVIEWER_HOLDS (reviewer-held at weight 0.25); `EDITOR_WORKING` = {accepted, in_progress, revision}.

### 4.2 Default transitions — `DEFAULT_WORKFLOW_TRANSITIONS` (seeded into `workflow_transitions`)

| From → To | Roles | Flags | Meaning |
|---|---|---|---|
| new → ready | O M P | | Mark ready |
| new → assigned, ready → assigned | O M P | requiresAssignedEditor | Assign (side effect of `assignEditor`, never direct) |
| ready → new | O M P | | Back to draft |
| assigned → accepted | O M E | assigneeOnly | Accept |
| assigned → in_progress | O M E | assigneeOnly | Start (implicit accept) |
| assigned → ready | O M P E | assigneeOnly | Decline (E) / unassign (O M P) |
| accepted → in_progress | O M E | assigneeOnly | Start |
| accepted → assigned | O M P | | Reassigned before start (engine-internal) |
| accepted → ready, in_progress → ready, revision → ready | O M P | | Unassign (engine-internal) |
| in_progress → submitted | O M E | assigneeOnly | Submit for review |
| submitted → review, resubmitted → review | O M P | | Begin review |
| submitted → revision, review → revision, resubmitted → revision | O M P | | Request revision (payload required) |
| submitted → approved, review → approved, resubmitted → approved | O M P | | Approve |
| revision → resubmitted | O M E | assigneeOnly | Resubmit |
| approved → delivered | O M P | | Deliver |
| approved → completed, delivered → completed | O M P | | Complete |
| approved → revision, delivered → revision | O M P | requiresAssignedEditor | Un-approve / client bounce |
| completed → revision, completed → in_progress | O M P | isReopen, requiresAssignedEditor | Reopen |
| completed → approved | O M P | isReopen | Reopen (fix delivery) |
| any ACTIVE → cancelled | O M P | generated per active status | Cancel (reason required) |
| cancelled → *(from_status of the cancel transition)* | O M P | computed, `job.restore` | Restore |
| any → any | O M | `job.transition_override`, reason required | Escape hatch, `is_override` |

### 4.3 `transitionJobStatus(tx, ctx, input)` — the only writer of `jobs.status_id`

Input: `{ jobId, toStatusId? | toCategory?, expectedVersion, reason?, override?, revision?: RevisionInput, startTimer?, cause?: "user" | "automation" | "sweep" | "seed" }`.

1. `TransitionInput.parse`; `job = loadJobInOrg(tx, ctx, jobId)`; resolve `toStatus` **inside `job.workflowId`** (by id, or by category → the non-archived status with the lowest `sort_order` in that category; ambiguity → 422 `AmbiguousTarget` listing candidates). Foreign/other-workflow status → 404.
2. `expectedVersion` mismatch → 409 `ConflictError` with the current job.
3. Edge = `workflow_transitions` row (from → to, non-archived). Missing edge: if `override` and `can(job.transition_override)` → proceed with `is_override`; else 422 `InvalidTransitionError`. Special cases: `cancelled → restore` (§4.5), lateral same-category moves between statuses of one category are allowed for anyone who may enter that category.
4. `assertTransitionActor`: `edge.allowedRoles ∋ ctx.role`; photographer → own; editor → assigned when `assigneeOnly`; `requiresAssignedEditor` → `job.editorId` set and active.
5. Guards by target category: `assigned/accepted/in_progress/revision/resubmitted` require an active editor; `revision` requires the revision payload (reason, description); `cancelled` and reopen require `reason`; `submitted/resubmitted` **warn** (not block) when no `finished_files`/`editing_workspace` current link; `delivered` warns when no `client_delivery`/`gallery`.
6. Ledger order (enforced by triggers): close the open transition (`exited_at`, `duration_seconds`) → insert the new transition row (`sequence + 1`, snapshots, `editor_id_at_entry`, `photographer_id_at_entry`, `is_reopen`, `is_override`, `reason`) → `UPDATE jobs … WHERE id = ? AND version = ?` (status pointers, milestones, `is_paused = false`, `version + 1`, `updated_at`).
7. Side effects (§4.4) in the same tx, each writing its own ledger rows + events.
8. `recordEvent(job.status_changed)` (+ the milestone event) with `metadata.transitionId`; set `transition.activity_event_id`.
9. Notifications (§6) and `enqueueAutomations(tx, event)` (§7) inside the tx; run pending automations after commit.

### 4.4 Side effects per target category

| Entering | `jobs` columns | Other writes | Notifications | Milestone event |
|---|---|---|---|---|
| ready (decline/unassign) | `editor_id = null`, `previous_editor_id` | close editor assignment (`unassign_reason` decline/unassigned), close the editor's running session (`auto_reassigned`), open revision `assignee_user_id = null` | decline: photographer + managers `job_declined`; editor `job_unassigned` | `job.declined` / `assignment.ended` |
| assigned (via `assignEditor`) | `editor_id`, `previous_editor_id` | assignment row (close prior with `reassigned`), close old editor's session | new editor `job_assigned`; old editor `job_reassigned` | `assignment.created/ended`, `job.status_changed` |
| accepted | — | — | — (UI shows) | `job.accepted` |
| in_progress | `started_at` (first time only), `is_paused=false` | if `startTimer` and tracking enabled → open work session | — | `job.work_started` (first) |
| submitted | `first_submitted_at ??= now`, `last_submitted_at`, `completion_percent = max(cur, 90)`, `review_due_date ??= now + review_sla_hours` (audited `job.review_due_date_changed` with `metadata.cause="sla_default"`) | close actor's session (`auto_status_change`) | photographer + creator `work_submitted` | `job.submitted` |
| review | — | — | — | `job.review_started` (metadata.reviewerUserId) |
| revision | `revision_count = n`, `open_revision_id` | insert `job_revisions` #n (`assignee = payload ?? editor`, `request_transition_id`); if payload names a different active editor → `assignEditor` first (same tx; the same applies to a later `PATCH /api/revisions/:id` assignee change); `job_notes` kind=revision with instructions (`revision_id`) | assignee `revision_requested` | `revision.requested` |
| resubmitted | `last_submitted_at` | open revision → `resolved_at/by`, `resolution=resubmitted`, `resolve_transition_id`; `open_revision_id = null`; close session | requester `work_resubmitted` | `revision.resolved` |
| approved | `approved_at`, `approved_by_user_id`, `due_date_at_approval = due_date`, `was_on_time = due_date IS NULL ? null : approved_at <= due_date`, `completion_percent = 100` | open revision (override path) → `resolution=approved` | editor `work_approved` | `job.approved` (metadata `{onTime, dueDateAtApproval, revisionCount}`) |
| delivered | `delivered_at` | — | — | `job.delivered` (metadata `{deliveryLinkIds}`) |
| completed | `completed_at`, `due_date_at_completion` | close all open sessions on the job | photographer + editor `job_completed` | `job.completed` |
| cancelled | `cancelled_at` | close sessions; open revision → `resolution=cancelled`; **assignments stay open** (history shows who held it) | editor + photographer `job_cancelled` | `job.cancelled` (reason) |
| reopen (`is_reopen`) | `completed_at = null`, `approved_at/delivered_at = null`, `reopened_count++` | if target needs an editor and none active → 422 `EditorRequired` (UI asks to assign first); target outside `EDITOR_REQUIRED_CATEGORIES` (submitted, review, approved, delivered) with a **deactivated** editor → the editor is released (`unassign_reason = user_deactivated`, `metadata.releasedInactiveEditorId`), same rule as restore | editor + photographer `job_reopened` | `job.reopened` (previous `{completedAt}`) |
| restore (from cancelled) | `cancelled_at = null` | target = `from_status_id` of the open cancel transition (initial status if archived); deactivated editor → editor-required target falls back to `ready`, any other active target releases the editor (`user_deactivated`, `metadata.releasedInactiveEditorId`) — a job never comes back "held by an inactive editor" without the deactivation's `kept` flag | editor + photographer `job_reopened` | `job.restored` |

Completion is never erased: the transition rows keep every completion; `completed_at` reflects only the current open completion.

### 4.5 Reassignment, decline, pause, bulk

- **`assignEditor(tx, ctx, { jobId, userId | null, reason, expectedVersion })`** (assignment service): closes the open editor assignment (`reassigned`/`unassigned`), auto-closes the old editor's running session (`auto_reassigned`), inserts the new assignment, re-points the open revision's `assignee_user_id`, sets `editor_id`/`previous_editor_id`. When an open revision is re-pointed, the new editor gets the mandatory `revision_requested` ("Revision #n on PJ-xxxx is now assigned to you", body = the revision's reason/instructions) **instead of** `job_assigned` — for manual, bulk, automation and deactivation hand-overs alike. Status handling:
  - category ∈ {new, ready} → `transitionJobStatus(→ assigned)`.
  - category ∈ {assigned, accepted} → status becomes `assigned` (new editor must accept) via the engine-internal edge.
  - category ∈ {in_progress, revision, resubmitted, submitted, review} → **status unchanged; the stage is re-attributed**: close the open transition row and insert a `kind='reattribution'` row (same `from/to status`, same category, `sequence + 1`, `editor_id_at_entry = new editor`, `reason = "reassigned"`). Per-editor stage time and turnaround therefore follow the new editor from this instant. Event `job.stage_reattributed`.
  - `userId = null` while editor-held → `→ ready` (unassign edge).
  - Old editor keeps read-only visibility via `past`.
- **Decline**: `POST /api/jobs/:id/decline` = assigned → ready by the assigned editor (reason optional), audited `job.declined`, `previous_editor_id` kept so the "assign back to previous editor" automation/UI works.
- **Pause / resume** (spec §2): `POST /api/jobs/:id/pause|resume`; allowed in `EDITOR_WORKING`; sets `is_paused/paused_at`; closes the running session (`paused`); events `job.paused`/`job.resumed`; notification `job_paused` to the photographer. Paused jobs still count in workload; My Work and Kanban show a "Paused" chip; the `stalled` bottleneck ignores paused jobs. Any transition clears `is_paused`.
- **User deactivation**: `deactivateUser({ userId, reassignTo? | unassign: true })`: for each open assignment → `assignEditor` (reassign) or unassign (`unassign_reason = user_deactivated`), close sessions (`auto_deactivated`), `session_version++`, `is_active = false`. The dialog shows the N open jobs and calls `POST /api/jobs/bulk/reassign`.
- **Bulk operations** (`POST /api/jobs/bulk/reassign | /bulk/priority | /bulk/transition`): one transaction **per job**, one event per job with `metadata.batchId`; no `expectedVersion` (each job is freshly loaded); response `BulkResult { ok[], failed[{id, code, message}], batchId }` (HTTP 200 even when some fail).
- **Concurrency**: all job mutations send `expectedVersion`; 409 returns `{ error: { code: "conflict", current } }` and the UI shows a conflict dialog with the other user's change (from the latest events).

### 4.6 Custom workflows

- Org-level `workflows`; `job_types.workflow_id` selects one; `jobs.workflow_id` is a snapshot. Changing a job type's workflow affects new jobs only. `POST /api/jobs/:id/migrate-workflow { workflowId, toStatusId }` moves one job (`kind='migration'` transition, event `job.workflow_migrated`).
- Validation on save (`src/lib/validation/workflow.ts`): exactly one `is_initial` with category `new`; every category in `WORKFLOW_REQUIRED_CATEGORIES` present ≥ 1; every non-terminal status has ≥ 1 outgoing non-archived edge; every status reachable from initial; `allowed_roles` non-empty; keys unique and slug-shaped; multiple statuses may share a category.
- Archiving a status is blocked while any job sits in it (UI offers bulk-move). Recategorising a status with jobs in it updates `jobs.status_category` for those jobs in the same tx (audited `status.updated`); history rows keep their snapshots.
- **Kanban drop mapping** (spec §9): a drop into column C resolves the target as follows — (1) candidate categories = `KANBAN_COLUMN_META[C].categories` in order; (2) candidate statuses = non-archived statuses of the job's workflow in those categories, ordered by category order then `sort_order`; (3) keep those with a non-archived edge from the current status that the actor may perform; (4) if the job's current category is already in C → no-op; (5) exactly one candidate → transition; (6) several → the UI opens a popover listing the candidates (status name + edge label) and the user picks; (7) none → the card snaps back with the explanation from `InvalidTransitionError`. Dropping onto Revision opens the revision-request dialog; dropping onto a target that requires a reason opens the reason dialog. `GET /api/jobs/:id/transitions` returns the actor's allowed edges so the board can pre-compute `allowedColumns` per card.

---

## 5. Audit taxonomy (`src/server/audit.ts`)

`recordEvent(tx, ctx, { entityType, entityId, jobId?, eventType, action, previousValue?, newValue?, metadata?, visibility? })` is the **only** insert path; it also bumps `jobs.last_activity_at` (no version bump) when `jobId` is set. `summary` is generated by `src/lib/audit-summaries.ts` and is **actor-less** ("changed status from Assigned to In Progress"); the UI renders `<actor name> <summary>` from `actor_user_id` at read time (so anonymisation works). `visibility = "management"` is forced for every `eventType` whose prefix ∈ `MANAGEMENT_EVENT_PREFIXES` and for note events with kind `internal`; feeds for photographers/editors filter it out. `metadata` always carries `{ requestId, cause: "user" | "automation" | "sweep" | "seed" | "recompute", automationRunId?, onBehalfOf?, batchId?, jobNumber?, jobName? }`. `redact()` removes `passwordHash` and any key matching `/password|secret|token/i`.

| eventType | entity / action | previousValue | newValue | metadata extras |
|---|---|---|---|---|
| `job.created` | job / created | null | `{jobNumber,name,clientId,projectId,jobTypeId,workflowId,statusId,priority,shootDate,dueDate,reviewDueDate,deliveryDueDate,photographerId,editorId,estimatedHours}` | |
| `job.field_changed` | job / updated | `{field, value}` | `{field, value}` | one event per field ∈ name, description, clientId, projectId, jobTypeId, estimatedHours, completionPercent |
| `job.priority_changed` | job / updated | `{priority}` | `{priority}` | |
| `job.due_date_changed` · `job.review_due_date_changed` · `job.delivery_due_date_changed` · `job.shoot_date_changed` | job / updated | `{value}` | `{value}` | `wasOverdue`, `cause` (`sla_default` for auto review deadline) |
| `job.status_changed` | job / transitioned | `{statusId,statusName,category}` | `{statusId,statusName,category}` | `transitionId, sequence, reason, revisionId?, isOverride, isReopen, lateral, onBehalfOf?, durationInPreviousSeconds` |
| `job.accepted` · `job.declined` · `job.work_started` · `job.submitted` · `job.review_started` · `job.approved` · `job.delivered` · `job.completed` · `job.cancelled` · `job.reopened` · `job.restored` | job / the milestone's own action: accepted · declined · started (work_started, review_started) · submitted (also resubmissions) · approved · delivered · completed · cancelled · reopened · restored | `{statusId,category}` (reopened/restored: `{completedAt|cancelledAt}`) | `{statusId,category}` | `transitionId`; approved `{onTime,dueDateAtApproval,revisionCount}`; submitted `{resubmission,revisionNumber?}`; cancelled/reopened `{reason}` |
| `job.paused` · `job.resumed` | job / paused·resumed | `{isPaused}` | `{isPaused}` | `sessionId?` |
| `job.stage_reattributed` | transition / updated | `{editorId}` | `{editorId}` | `transitionId, previousTransitionId, category` |
| `job.became_overdue` | job / flagged | null | `{dueDate, overdueSince}` | `cause:"sweep"`; **one per (jobId, dueDate)** — the sweep checks the latest such event's `newValue.dueDate` before emitting; a deadline change re-arms it |
| `job.review_overdue` | job / flagged | null | `{reviewDueDate}` | same dedupe per (jobId, reviewDueDate) |
| `job.workflow_migrated` | job / migrated | `{workflowId,statusId}` | `{workflowId,statusId}` | `transitionId` |
| `assignment.created` | assignment / assigned | `{userId}` or null | `{userId, role}` | `assignmentId, reason, statusCategory` |
| `assignment.ended` | assignment / unassigned | `{userId, role, assignedAt}` | null | `assignmentId, unassignReason` |
| `revision.requested` | revision / requested | null | `{revisionNumber,reason,description,instructions,priority,dueDate,assigneeUserId}` | `revisionId, transitionId` |
| `revision.resolved` · `revision.withdrawn` | revision / resolved·withdrawn | `{resolvedAt:null}` | `{resolvedAt,resolvedByUserId,resolution,resolutionNote}` | `revisionId, revisionNumber, transitionId?` |
| `revision.updated` | revision / updated | changed fields | changed fields | `revisionId` |
| `comment.added` | comment / created | null | `{body, kind, parentCommentId, rootCommentId, revisionId, mentionUserIds}` | `commentId` |
| `comment.edited` | comment / updated | `{body}` | `{body}` | `commentId, editCount` |
| `comment.deleted` | comment / soft_deleted | `{body}` | null | `commentId` |
| `comment.mentioned` | comment / mentioned | null | `{mentionedUserId}` | `commentId` (one per mention; feeds `mentioned` notifications) |
| `note.added` · `note.edited` · `note.archived` · `note.restored` | note / created·updated·archived·restored | `{body}` (edited/archived) | `{kind, body}` | `noteId, editCount`; `visibility=management` when kind = internal |
| `link.added` | link / created | null | `{linkId,kind,url,label,provider}` | |
| `link.replaced` | link / superseded | `{linkId,url,label}` | `{linkId,url,label}` | `kind, supersedesLinkId` |
| `link.updated` | link / updated | `{linkId,kind,label}` (old row) | `{linkId,kind,label}` (new row) | `kind, previousKind, supersedesLinkId, url` |
| `link.removed` | link / removed | `{linkId,kind,url,label}` | null | `reason` |
| `work_session.started` | work_session / started | null | `{sessionId,statusId,category,transitionId}` | |
| `work_session.ended` | work_session / paused·stopped | `{startedAt}` | `{endedAt,durationSeconds,endReason}` | `sessionId, closedBy: "user"|"submit"|"reassign"|"complete"|"deactivate"|"timeout"` |
| `user.created` · `user.updated` · `user.role_changed` · `user.deactivated` · `user.reactivated` · `user.password_changed` · `user.capacity_changed` · `user.flags_changed` · `user.anonymised` · `user.notification_prefs_changed` | user / … | field snapshot (never hashes) | field snapshot | `targetUserId` = entityId; deactivated `{openJobs:[{jobId,action}]}`; management |
| `user.workload_band_changed` | user / flagged | `{band}` | `{band, score, ratio, active}` | `cause:"sweep"`; emitted only when the band differs from the latest such event; feeds `workload_threshold` notifications/automations; management |
| `auth.logged_in` · `auth.login_failed` · `auth.logged_out` | auth / logged_in… | null | `{email}` | `ip, userAgent`; management |
| `team.created` · `team.updated` · `team.archived` · `team.member_added` · `team.member_removed` | team / … | snapshot | `{userId}` | `membershipId`; management |
| `client.*` · `project.*` (created, updated, archived, restored) | client/project / … | changed fields | changed fields | |
| `workflow.*` · `status.*` (created, updated, archived, reordered) · `workflow_transition.*` · `job_type.*` | … | snapshot | snapshot | `workflowId`; management |
| `automation.created/updated/enabled/disabled/archived` | automation / … | `{trigger,conditions,actions,isEnabled}` | same | management |
| `automation.ran` | automation_run / ran | null | `{status, actionsPerformed}` | `automationRunId, triggerEventId, depth` (jobId set); management |
| `settings.updated` | settings / updated | `{field,value}` per field | `{field,value}` | management |
| `notification.sent` | notification / created | null | `{type,userId}` | only when `audit_notifications`; management |
| `saved_view.created/updated/deleted` · `dashboard.updated` | saved_view/dashboard / … | config | config | not shown in job feeds |

Explicit exemptions (not audited): `notifications.read_at`, `users.last_login_at`, `jobs.last_activity_at`, `organisation_settings.last_overdue_sweep_at`.

**Anonymisation** (`anonymiseUser`, owner-only, target must be deactivated): rewrites `users.name → "Former team member"`, `email → anon-<id>@invalid`, `password_hash` random, `avatar_colour` grey, `anonymised_at`; soft-deletes the user's comments? **No** — comments stay (business record) but the author renders as "Former team member" because names are joined at read time; events are untouched (actor-less summaries; previous/new snapshots of *user* events contain the old name — accepted, documented limitation). Event `user.anonymised`.

---

## 6. Notifications (`src/server/services/notifications.ts`)

`notify(tx, ctx, { userIds, type, title, body, jobId, activityEventId, linkPath, dedupeKey? })` — never notifies the actor; skips inactive users; skips users whose `user_notification_prefs` row disables the type unless `NOTIFICATION_TYPE_META[type].mandatory`; dedupes per `(user, event, type)` and per `(user, dedupeKey)`.

**Channels.** The `notifications` row is the in-app delivery. Other channels implement `NotificationChannel { id; deliver(notification, user): Promise<void> }` and are added with `registerNotificationChannel()` (registry in `services/notifications.ts`, in-app channel `IN_APP_CHANNEL` always present). `notify()` queues the inserted ids only when an external channel is registered; `dispatchPendingNotifications()` runs post-commit (scheduled with `setImmediate`: transactions are synchronous, so the tx has committed or rolled back by then — rolled-back rows no longer exist and are dropped) and hands each committed row + a password-free user projection to every external channel; failures are logged, never rethrown. With only the in-app channel the hook is a no-op.

| Type | Recipients |
|---|---|
| job_assigned / job_reassigned / job_unassigned / job_declined | new editor / old editor / old editor / photographer + managers |
| deadline_changed | editor (if any) + photographer when the actor is a manager; managers are **not** notified |
| priority_changed | editor (if any); photographer when changed by a manager |
| comment_added | job photographer, editor, creator and every previous commenter in the thread |
| mentioned | the mentioned user (mandatory) |
| revision_requested | revision assignee (mandatory) |
| work_submitted / work_resubmitted | photographer + creator |
| work_approved | editor |
| job_overdue | editor + photographer (+ managers via automation); dedupeKey `overdue:<jobId>:<dueDate>` |
| review_overdue | photographer + managers; dedupeKey `review_overdue:<jobId>:<reviewDueDate>` |
| job_completed | photographer + editor |
| job_reopened | editor + photographer (+ managers when reopened by a photographer) |
| job_cancelled | editor + photographer |
| job_paused | photographer |
| workload_threshold | managers + owner; dedupeKey `workload:<editorId>:<band>:<civilDate>` |
| editor_unavailable | managers (sweep: active jobs held by an inactive editor); dedupeKey `unavailable:<editorId>:<civilDate>` |
| automation | whoever the rule targets — **minus** anyone who already received a built-in notification about the same job caused by the same trigger (the trigger event itself or any event sharing its `metadata.transitionId`), see §7 |

---

## 7. Automations (`src/server/services/automationEngine.ts`)

- Triggers (`AutomationTrigger.type`): `job_created`, `status_changed` (filters `toCategory`/`fromCategory`/`toStatusKey`), `job_assigned`, `job_reassigned`, `deadline_changed`, `priority_changed`, `revision_requested`, `job_overdue`, `workload_threshold` (band). Conditions: `AutomationCondition[]` (AND). Actions: `notify`, `assign_editor` (previous/original/user), `transition` (toCategory), `set_priority`, `add_note`. The action allowlist for the system context is exactly these five.
- **Enqueue inside the human transaction**: `recordEvent()` calls `enqueueAutomations(tx, ctx, event)` (`src/server/services/automationTriggers.ts`) after every event insert, which inserts one `automation_runs` row (`status=pending`, `depth = parent.depth + 1 or 0`) per enabled matching rule; `UNIQUE(automation_id, trigger_event_id)` makes it idempotent.
- **Execute after commit** (`runPendingAutomations(orgId)`): each run in its own transaction with `SAVEPOINT` isolation using `systemContext(orgId)` (`isSystem`, `actorUserId = null`, `metadata.automationRunId`); evaluates conditions (`skipped`), performs actions (`succeeded`/`failed` with `error`, never throws to the caller); events produced carry `automation_run_id`; `automation.ran` event; depth > `AUTOMATION_MAX_DEPTH` → `skipped` with reason; org `automations_enabled = false` → `skipped`.
- **Replay**: the sweep re-runs any `pending` run older than 60 s (lost between commit and execution), which is safe because the run row is the dedupe key.
- `POST /api/automations/:id/dry-run { jobId }` evaluates trigger + conditions and lists the actions without writing.
- **No double notices**: a `notify` action skips recipients who already got a non-automation notification for the same job caused by the trigger event (same `activity_event_id`, or an event of the same status transition — e.g. `work_submitted` hangs off `job.submitted` while a status_changed rule fires on `job.status_changed`); the action still succeeds with "Already notified about this by the built-in notice".

---

## 8. Metrics, thresholds, bottlenecks (`src/lib/metrics.ts` pure, `src/server/queries/metrics.ts` SQL)

Notation: `T(job)` = transitions by `sequence`; `dur(t) = (exited_at ?? now) − entered_at`; `firstEnter(cat)` / `lastEnter(cat)` = min/max `entered_at` with `to_category = cat` (`kind ≠ reattribution` for first/last-enter). Period bounds via `resolveRange()` in org tz.

| Metric | Formula | Reads |
|---|---|---|
| Time in stage | `dur(t)` per transition; per job per category Σ; "time in current status" = `now − jobs.status_entered_at` | transitions |
| Turnaround (job) | `approved_at − firstEnter(assigned)` (fallback `firstEnter(in_progress)`, then `created_at`); undefined until approved | jobs, transitions |
| Turnaround (editor E, range) | mean over jobs with `approved_at ∈ range` whose approving editor (editor_id_at_entry of the transition into `approved`, else the open editor assignment at that instant) = E | transitions, assignments |
| Editing time (job) | Σ `dur(t)` for `to_category ∈ {in_progress, revision}`; per editor use `editor_id_at_entry = E` (reattribution rows attribute correctly). With time tracking: **active editing time** = Σ `work_sessions.duration_seconds` | transitions, work_sessions |
| Review time (job) | Σ `dur(t)` for `to_category ∈ REVIEWER_HOLDS` | transitions |
| Avg time per stage (editor) | mean `duration_seconds` grouped by `to_category` over closed rows with `editor_id_at_entry = E` | transitions |
| Revision rate (editor/org, range) | `jobsWithRevision / jobsApproved`, jobsApproved = jobs with `approved_at ∈ range` (editor = approving editor); jobsWithRevision = those with `revision_count ≥ 1`; **revisions per job** = Σ revision_count / jobsApproved | jobs |
| On-time % | `count(was_on_time = 1) / count(approved_at ∈ range ∧ due_date_at_approval IS NOT NULL)` | jobs |
| Processing time (photographer) | `first_submitted_at − start of the shoot's civil day` (org tz; `shoot_date` is a day, not an instant; clamped ≥ 0) and `completed_at − created_at` for jobs where photographer_id = P | jobs |
| Completed this week/month | jobs whose **latest** transition into `completed` has `entered_at ∈ range` **and** the job's open stage is `completed` (`completed_at ∈ range`). A job completed last week, reopened, re-completed this week counts **this week only**. The dashboard KPI and the Editors report share `completedInRange()` | jobs |
| KPI cards | Active = `ACTIVE`; Due Today = `DEADLINE_BOUND ∧ civil(due_date) = today`; Overdue = `DEADLINE_BOUND ∧ due_date < now`; Awaiting Editor = `AWAITING_EDITOR`; In Editing = `{in_progress}`; Awaiting Review = `REVIEWER_HOLDS`; Revision Required = `{revision}`; Completed This Week as above | jobs |
| Days remaining | `civilDiffDays(today, civil(due_date))`; negative = overdue; null = no due date | jobs |
| Completion % | `jobs.completion_percent` (user-set; transitions floor it: in_progress ≥ 5, submitted/resubmitted ≥ 90, approved = 100) | jobs |
| Workload score (editor) | `Σ over jobs with editor_id = E ∧ category ∈ WORKLOAD: estHours × priorityWeight × dueWeight × categoryWeight`; `estHours = estimated_hours ?? job_type.default_estimated_hours ?? settings.default_estimated_hours`; `priorityWeight = PRIORITY_META[p].weight` (0.8/1/1.3/1.6); `dueWeight = overdue → 1.5, due ≤ 48h → 1.25, else 1`; `categoryWeight = STATUS_CATEGORY_META[c].workloadWeight` (1 editor-held, 0.25 reviewer-held) | jobs, job_types, settings |
| Workload band | `ratio = score / (capacity ?? default)`; `healthy < near(0.7) ≤ near_capacity < overloaded(1.0) ≤ overloaded`; forced `overloaded` when `active ≥ max_active_jobs_per_editor` or `overdue ≥ 3` (`bandReason`); inactive editor → `overloaded` with `bandReason = inactive` | users, settings |
| Historical workload (editor detail chart) | for each civil day d in range: count/score of jobs where an editor assignment for E was open at d (`assigned_at ≤ d < unassigned_at`) **and** the transition open at d (`entered_at ≤ d < exited_at`) had `to_category ∈ EDITOR_HOLDS` — from `job_assignments` × `job_status_transitions` only | assignments, transitions |

Bottlenecks (`src/server/queries/bottlenecks.ts` → `BottleneckAlert[]`):

| kind | Rule | Message |
|---|---|---|
| review | `n = jobs with category ∈ REVIEWER_HOLDS ∧ now − status_entered_at > review_bottleneck_hours`; fires when `n ≥ review_bottleneck_min_jobs` | "Review bottleneck — {n} jobs waiting for review > {h}h" |
| editor_overloaded | per editor: band = overloaded, or `active ≥ max_active_jobs_per_editor ∧ dueWithin48h ≥ editing_bottleneck_min_due_soon` | "Editing bottleneck — {name} has {active} active jobs, {k} due within 48h" |
| revision_spike | unit = revision **requests**: `thisWeek = revisions requested in the last 7 days`; `baseline = mean of the previous 4 weekly (7-day) counts`; fires when `thisWeek ≥ revision_spike_min_count ∧ thisWeek ≥ revision_spike_multiplier × baseline` (baseline 0 → first condition only); the alert lists the distinct jobs | "Revision bottleneck — {n} revision requests in the last 7 days" (or "… {n} revision requests on {k} jobs in the last 7 days" when k < n) |
| unassigned_backlog | `count(UNASSIGNED) ≥ unassigned_backlog_min` or any unassigned job due within 48h | "Unassigned backlog — {n} jobs waiting for an editor ({k} due within 48h)" |
| stalled | `ACTIVE ∧ ¬is_paused ∧ last_activity_at < now − stalled_days` | "Stalled — {n} jobs with no activity for {d} days" |
| editor_unavailable | active jobs with `editor_id` → `users.is_active = false` | "{n} jobs assigned to a deactivated editor" |
| review_overdue | `REVIEWER_HOLDS ∧ review_due_date < now` | "Review deadlines passed — {n} jobs" |

**Sweep** (`src/server/services/sweep.ts`, `POST /api/system/sweep`, also invoked from the app layout when `last_overdue_sweep_at` is older than `SWEEP_MIN_INTERVAL_MINUTES`): emits `job.became_overdue` / `job.review_overdue` (deduped per job+deadline) with notifications and `job_overdue` automations; evaluates workload bands and emits `user.workload_band_changed` only on change (+ `workload_threshold` notifications/automations); `editor_unavailable` notifications; replays stale pending automation runs; auto-closes work sessions older than `work_session_auto_timeout_minutes` (`auto_timeout`); updates `last_overdue_sweep_at`. No built-in cron: without a scheduler an org with no traffic gets its overdue notifications on the next visit. To fire them on time, point any scheduler at `GET|POST /api/system/cron/sweep` with `Authorization: Bearer $CRON_SECRET` (all organisations, `src/server/cron.ts`).

---

## 9. API surface (`src/app/api/**/route.ts`)

Every handler: `handle(async (req) => { const ctx = await requireContext(); return service(ctx, await bodyOrNull(req)) })`. JSON `{ data }` / `{ error: { code, message, details?, current? } }`. Lists accept `?cursor&limit≤200`. Mutations on versioned rows take `expectedVersion`. Server actions (`src/server/actions/*.ts`) exist for forms and call the same services.

**Auth** — `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `POST /api/auth/change-password`
**Jobs** — `GET /api/jobs` (filters: `q, quick, statusCategory[], statusId[], editorId[], photographerId[], clientId[], projectId[], jobTypeId[], priority[], dueFrom, dueTo, sort, groupBy, viewId`) · `POST /api/jobs` · `GET /api/jobs/:id` (`JobDetail`) · `PATCH /api/jobs/:id` (fields, priority, dates, completion %, per-field permission) · `GET /api/jobs/by-number/:jobNumber` · `GET /api/jobs/:id/transitions` (allowed edges for actor) · `POST /api/jobs/:id/transition` · `POST /api/jobs/:id/accept|decline|start|submit|pause|resume|approve|deliver|complete|cancel|reopen|restore` (thin wrappers over transition/pause) · `POST /api/jobs/:id/assign` `{ role, userId | null, reason }` · `POST /api/jobs/:id/migrate-workflow` · `POST /api/jobs/:id/recompute` (owner) · `GET /api/jobs/:id/history` · `GET /api/jobs/:id/activity` · `GET /api/jobs/:id/timeline` · `POST /api/jobs/bulk/reassign` · `POST /api/jobs/bulk/priority` · `POST /api/jobs/bulk/transition`
**Revisions** — `GET /api/jobs/:id/revisions` · `POST /api/jobs/:id/revisions` (= transition → revision) · `PATCH /api/revisions/:id` (assignee/instructions/priority/due while open) · `POST /api/revisions/:id/resolve` (= → resubmitted) · `POST /api/revisions/:id/withdraw`
**Comments** — `GET /api/jobs/:id/comments` · `POST /api/jobs/:id/comments` `{ body, parentCommentId?, kind, revisionId?, mentionUserIds[] }` · `PATCH /api/comments/:id` · `DELETE /api/comments/:id` (soft)
**Notes** — `GET|POST /api/jobs/:id/notes` · `PATCH /api/notes/:id` · `POST /api/notes/:id/archive|restore` · `GET /api/notes/:id/history`
**Links** — `GET /api/jobs/:id/links?history=1` · `POST /api/jobs/:id/links` · `POST /api/links/:id/replace` · `PATCH /api/links/:id { kind?, label? }` (→ the new current `JobLink`; re-file/relabel, same URL) · `POST /api/links/:id/remove`
**Time tracking** — `POST /api/jobs/:id/timer` `{ action: start|pause|stop, note? }` · `GET /api/jobs/:id/sessions` · `GET /api/me/timer`
**Clients / Projects** — `GET|POST /api/clients` · `GET|PATCH /api/clients/:id` · `POST /api/clients/:id/archive|restore` · `GET|POST /api/projects` (`?clientId`) · `GET|PATCH /api/projects/:id` · `POST /api/projects/:id/archive|restore`
**Users / Teams** — `GET /api/users` (`?role&active`; reduced projection for P/E) · `POST /api/users` (invite, temp password) · `GET|PATCH /api/users/:id` · `POST /api/users/:id/role|deactivate|reactivate|reset-password|anonymise` · `GET|PUT /api/users/:id/notification-prefs` · `GET|POST /api/teams` · `PATCH /api/teams/:id` · `POST /api/teams/:id/archive` · `POST /api/teams/:id/members` · `POST /api/teams/:id/members/:userId/remove`
**Workloads / analytics** — `GET /api/workloads` · `GET /api/workloads/:userId` (`WorkloadDetail` incl. history series) · `GET /api/analytics/overview|editors|photographers|business?range` · `GET /api/analytics/editors/:userId?range` · `GET /api/analytics/me` · `GET /api/bottlenecks` · `GET /api/reports/:kind?range&format=json|csv` (kind: production|editors|photographers|business)
**Dashboard** — `GET /api/dashboard` · `GET|PUT /api/dashboard/layout`
**Activity / Notifications / Search / Views** — `GET /api/activity?userId&jobId&eventType[]&from&to&cursor` · `GET /api/notifications?unread=1` · `POST /api/notifications/:id/read` · `POST /api/notifications/read-all` · `GET /api/search?q=` · `GET|POST /api/views?scope` · `PATCH|DELETE /api/views/:id`
**Settings** — `GET|PATCH /api/settings` · `GET /api/settings/permissions` (matrix) · `GET|POST /api/workflows` · `GET|PATCH /api/workflows/:id` · `POST /api/workflows/:id/archive` · `POST /api/workflows/:id/statuses` · `PATCH /api/statuses/:id` · `POST /api/statuses/:id/archive` · `POST /api/workflows/:id/reorder` · `POST /api/workflows/:id/transitions` · `PATCH /api/transitions/:id` · `POST /api/transitions/:id/archive` · `GET|POST /api/job-types` · `PATCH /api/job-types/:id` · `POST /api/job-types/:id/archive` · `GET|POST /api/automations` · `GET|PATCH /api/automations/:id` · `POST /api/automations/:id/toggle|archive|dry-run` · `GET /api/automations/:id/runs` · `GET /api/automation-runs?status&jobId`
**System** — `POST /api/system/sweep` · `GET /api/system/integrity` (owner; `IntegrityReport`)

There are no `DELETE` routes except the soft comment delete and saved views (archive).

---

## 10. Page map (`src/app/(app)/…`; hrefs match `src/config/nav.ts`)

The simplified product (docs/SIMPLIFICATION-PLAN.md): **shoot → give it to an editor → check → done.** Five stages (`src/lib/stages.ts`: Needs editor · With editor · Ready to check · Changes asked · Done, + Cancelled) are a display layer over the 13 status categories; `StagePill` / `WaitingOn` / `RoundBadge` / `RushBadge` (`src/components/jobs/stage-pill.tsx`) are the only stage visuals. Navigation per persona (plan §3): owner / co-owner **Home · Jobs · Editors · Clients · Settings**; extra photographer **Home · Jobs · Clients**; editor **My jobs · Calendar**; the **Advanced** group appears only while Settings → Studio → Advanced tools is on. Topbar: Search (Ctrl K), + New job, bell, avatar (My account · Help · Log out). Phone tabs: Home (red "to check" count) · Jobs · (+) · Editors · More; editors: My jobs · Calendar · Search · Me.

Layout: sidebar / drawer / tab bar driven purely by `navGatesFor(ctx)`; every list page ships `loading.tsx`, `error.tsx` and an `EmptyState`; pages re-check with `guard` / `load` server-side. Hidden (Advanced) pages are blocked on the server: `requireAdvanced` (404) or `redirectUnlessAdvanced` (307 to the simple replacement) in a `layout.tsx` above the loading boundary; hidden APIs 404 through `requireRouteContext` (`src/app/api/_lib/advanced.ts`). Old addresses redirect (`LEGACY_REDIRECTS` in `next.config.ts`).

| Route | Shows | Who |
|---|---|---|
| `/` | Lands by role: photographers → `/home`, editors → `/my-jobs`, clients → `/portal` (`homePathFor`, also the login's `redirectTo`). | all |
| `/home` | Owner / photographer Home (plan §6): "Good morning, Mo. 3 to check · 2 late · 1 needs an editor" (each part links to the filtered Jobs tab) + New job; **Ready to check** (oldest first; Open finished photos · Approve · Ask for changes — the same `ApproveButton` / `AskForChangesDialog` as the job page); **Needs attention** (plain reasons, Assign editor); **Your editors** (owners); **Coming up this week**; one-time "Proofline got simpler" card; empty-studio state. Extra photographers see their own shoots and no editors block. | photographers (editors → `/my-jobs`) |
| `/my-jobs` | Editor home (plan §6): "Hi Sam. Next up: …"; Changes asked (quotes the request) · Late · To do · Waiting for <name> to check (collapsed) · Done recently (collapsed); cards with Raw files and ONE button (Start editing / Send for checking, link required); footer with their own five numbers. | editors (others → their home) |
| `/jobs` | The one list of jobs (plan §1, §4): stage tabs with counts (All active · Needs editor · With editor · Ready to check · Changes asked · Done), Late and Show cancelled switches, Search / Editor / Client, **List / Calendar** switch (`?view=calendar&month=`). Table from `md`, cards on phones; rows = name · client · StagePill · Waiting on · due chip · Round / Rush · editor · finished-photos icon. URL state only (`src/components/jobs-list/params.ts`). | photographers (editors → `/my-jobs`) |
| `/calendar` | Editor-only month view of their own due dates; photographers → `/jobs?view=calendar`. | editors |
| `/jobs/new` | One screen, 8 fields (Client · Address / job name · Type of shoot · Shoot date · Due date = shoot + usual days · Editor "Decide later" · Raw files link · Instructions) + collapsed More options (Rush, Photographer when > 1, Client delivery date, Other links). Projects are silent (`autoProject`). `?clientId=`, `?editorId=` pre-select. | job.create |
| `/jobs/[id]` | The single-scroll job page (plan §5): header (StagePill, Waiting on, due, Round, Rush, Shot by · Edited by, ⋯ menu) → **Next step** card (one sentence, ≤ 2 buttons by stage × viewer; pinned above the tab bar on phones) → Files (Raw · Finished + Earlier versions · Other) → Instructions → Changes asked rounds → Messages → Private notes (staff) → From the client → Who did what + Full history → Details side column. `/jobs/PJ-0012` resolves; `/jobs/[id]/history` = the full audit log; `/jobs/[id]/edit` = the slim edit form. | job.view |
| `/editors`, `/editors/[id]` | Tracking editors (plan §7): "Waiting on you: N edits to check (oldest …)"; period switch; five numbers per editor (On their desk · Late now · Finished · On time · Needed changes; "Not enough jobs yet" below 5 finished; "4 of 6" with Usually handles up to N); Download CSV (`/api/editors.csv`); extra photographers table. Editor page: the five numbers vs last period, On their desk now (Change editor), Recently finished, finished-per-week chart, Give them a job · Move their jobs to… · Edit person. | admins (members with analytics) |
| `/clients`, `/clients/new`, `/clients/[id]` | Clients with open / late counts and search; client page = contact, jobs grouped by address with stage pills, **Online access** card (portal switch, feedback, who can sign in). Editors → `/my-jobs`. | photographers |
| `/settings/studio` | Studio name, timezone, job number prefix; **Advanced tools** switch with the plain list of what it reveals; Close delivered jobs (owner-confirmed). | admins |
| `/settings/people`, `/settings/people/[id]` | Three role cards (Owner · Photographer · Editor) with counts, list, search, Active / Deactivated; **Invite** with 3 roles + "Only their own shoots \| Everything (co-owner)" and the editor's "Can add their own jobs" tick (off by default); person page: preset, Usually handles up to N, temporary password, deactivate with "Move their jobs to…". | admins |
| `/settings/shoot-types` | Types of shoot: name, colour, **usual days to edit** (workflow + hours Advanced-only). | admins |
| `/settings/account` | Profile, password, Notifications as 8 groups (+ "More updates", "Mark old updates as read"), appearance Light / Dark / System. | self |
| `/settings/history` | The studio-wide audit log with filters and CSV (was `/activity`). | admins |
| `/notifications`, `/search?q=`, `/help` | Notification centre; search (an exact job number jumps to the job); one-page Help (5 stages, 3 roles, how to check, the new job form, where things are). | self / all |
| `/settings` | → `/settings/studio` (admins) or `/settings/account`. | — |
| **Advanced** (hidden unless the studio switch is on): `/workspace/kanban` (Board; columns labelled with the stage words), `/workspace/timeline`, `/insights/analytics`, `/insights/bottlenecks`, `/insights/reports`, `/team/workloads`, `/team/performance`, `/settings/workflows`, `/settings/automations`, `/settings/teams`, `/settings/roles`, `/projects` | Unchanged pages behind `redirectUnlessAdvanced` (307 to `/jobs`, `/editors`, `/settings/studio`, `/settings/people`); 403 for non-admins once on. | admins with Advanced on |
| **Legacy redirects** (`LEGACY_REDIRECTS`): `/dashboard` → `/home`; `/workspace/all\|team\|my(-work)` → `/jobs`; `/workspace/calendar` → `/calendar`; `/team/editors(/:id)`, `/team/users/:id`, `/team/workloads`, `/team/performance` → `/editors(/:id)`; `/team/photographers` → `/settings/people`; `/activity` → `/settings/history`; `/settings/organisation\|users\|job-types\|profile\|appearance\|notifications` → the new tabs | 307 | all |
| `(auth)/login` | Login form, "Continue with Google" (when configured), the "Look around the demo" persona buttons (no demo emails / passwords shown), rate-limit message. Lands by role (`loginRedirectTarget`). Accounts: docs/ACCOUNTS.md. | public |
| `/portal/**` | Client portal: Your work (Booked → Shot → Editing → Delivered) · Notifications · Account. Unchanged. | clients |

---

## 11. Modules

**Server** (`src/server/`): `auth/session.ts` (jose, cookie, `requireContext`, `systemContext`), `auth/password.ts`, `auth/permissions.ts` (POLICY, can, assertCan, visibleJobsWhere), `auth/db-rate-limit.ts` (Postgres-backed limits, `auth_rate_limits`), accounts helpers (`auth/session-token.ts`, `auth/sign-in.ts`, `auth/demo.ts`, `auth/email-confirmation.ts`, `auth/google-config.ts`, `auth/google-oidc.ts` — docs/ACCOUNTS-PLAN.md §3), `audit.ts` (`recordEvent`), `clock.ts`, `errors.ts`, `http.ts` (`handle`, CSRF), `services/_shared.ts` (loaders), `services/auth.ts`, accounts services (`account.ts`, `emailVerification.ts`, `googleAuth.ts`, `demo.ts`, `authLimits.ts`, `accountNotices.ts` — docs/ACCOUNTS.md), `jobs.ts` (create/update/pause/bulk/recomputeJobDerived), `assignments.ts` (`assignEditor`, `assignPhotographer`), `workflow.ts` (`transitionJobStatus`, restore, migrate, allowed transitions), `revisions.ts`, `comments.ts`, `notes.ts`, `links.ts`, `timeTracking.ts`, `clients.ts`, `projects.ts`, `users.ts` (invite, deactivate, anonymise, prefs), `teams.ts`, `settings.ts`, `workflows.ts` (admin CRUD + validation), `jobTypes.ts`, `automations.ts` (CRUD) + `automationEngine.ts`, `notifications.ts`, `savedViews.ts`, `dashboards.ts`, `sweep.ts`.

**Queries** (`src/server/queries/`): `scope.ts` (re-exports `visibleJobsWhere`, redaction helpers), `dashboard.ts`, `jobs.ts` (list/filter/sort/group → `JobRow[]`), `jobDetail.ts` (→ `JobDetail`), `jobHistory.ts` (stages + events → `HistoryEntry[]`), `myWork.ts`, `teamWork.ts`, `kanban.ts`, `calendar.ts`, `timeline.ts`, `workloads.ts`, `performance.ts`, `analytics.ts`, `metrics.ts` (CTEs), `bottlenecks.ts`, `reports.ts`, `activity.ts`, `notifications.ts`, `search.ts`, `clients.ts`, `projects.ts`, `users.ts`, `teams.ts`, `settings.ts`, `workflows.ts`, `automations.ts`, `views.ts`.

**Lib** (`src/lib/`): `constants.ts`, `types.ts`, `dates.ts`, `utils.ts`, `ids.ts`, `metrics.ts` (pure), `workflow.ts` (pure graph helpers, kanban mapping), `audit-summaries.ts`, `validation/{auth,jobs,workflow,revisions,comments,notes,links,users,teams,clients,projects,settings,automations,views,json}.ts`, `nav` lives in `src/config/nav.ts`.

**DB** (`src/db/`): `schema.ts`, `index.ts`, `guard.ts`, `verify.ts`, `seed.ts`, `reset.ts`, `test-db.ts` (`makeTestDb()` = `:memory:` + `drizzle-kit`-equivalent DDL via `pushSchema()` + `installGuards`).

---

## 12. Demo data plan (`src/db/seed.ts`)

Seed through the **real services** with a seeded PRNG (`mulberry32(42)`) and a movable clock (`setClock()` in `src/server/clock.ts`), so every job's history, events, notifications, revisions and sessions come from production code paths. `db:reset` = delete file → `db:push` → `db:guard` → `db:seed`. The seed ends by running the sweep, then `verifyDerived()` — any drift aborts with a non-zero exit.

1. **Organisation** "Northlight Studios" (slug `northlight`, tz `Australia/Sydney`, time tracking **on**, default thresholds) plus a second tiny **"Other Studio"** (1 owner `owner@other.test`, 1 editor, 3 jobs) used by e2e isolation tests.
2. **Users** (password `Password123!`): `owner@studio.test`; `manager1@`, `manager2@`; `photographer01..12@studio.test`; `editor01..12@studio.test` (capacities 30–40 h); `editor13@` deactivated 10 days ago with reassignment history; `editor11` deactivated but still holding 2 open jobs (editor-unavailable bottleneck); `photographer01` with `can_view_team_workloads` + `can_view_analytics`; avatar colours from `AVATAR_PALETTE`.
3. **Teams**: "Real Estate Crew", "Weddings", "Commercial" (4 P + 4 E each, one lead, one editor in two teams).
4. **Workflows**: default 13-status (`DEFAULT_WORKFLOW_STATUSES/TRANSITIONS` + generated cancel edges); "Quick Turnaround" (no accepted/review/delivered); "Video" (two `in_progress` stages "Rough Cut"/"Final Cut", `review` named "Client Review") to prove category mapping. **Job types**: `DEFAULT_JOB_TYPES` (Video → Video workflow; Retouching/Virtual Staging → Quick Turnaround).
5. **Clients** 32 (2 archived) → **Projects** 55 (addresses, wedding names, campaigns).
6. **Jobs** 160, created over the last 120 days (right-skewed), scripted lifecycles per target bucket: new/ready 12 · assigned/accepted 14 · in_progress 24 (8 overdue, 2 paused, 6 with sessions incl. one running) · submitted/review 16 (8 waiting > 24 h → review bottleneck, 3 past `review_due_date`) · revision 12 (4 at #2, 1 at #3; 3 overdue) · resubmitted 8 · approved/delivered 14 (mix of on-time/late; half delivered with `client_delivery` + `gallery`) · completed 52 (30 with 0 revisions, 16 with 1, 6 with 2+; 12 this week, 10 last week; **2 completed last week, reopened and re-completed this week**; 4 late) · cancelled 8 (1 restored later). Across jobs: 5 reassigned mid-edit (reattribution rows), 5 with due-date changes (one after approval to prove as-of on-time), 10 with replaced links, every job has `raw_files`, editing jobs `editing_workspace`, submitted+ `finished_files`; notes of 2–3 kinds; 0–6 comments with 20 % replies and 10 % mentions; `editor03` engineered overloaded (14 active, 5 due within 48 h), `editor07` near capacity; a revision spike (14 in the last 7 days vs ~5/week); 1 workflow migration.
7. **Automations** (5): submitted → notify managers; overdue → notify managers (the photographer / editor already get the built-in `work_submitted` / `job_overdue`, §6–7); revision requested with `revisionCount >= 2` → assign back to the *original* editor (see §14); approved → complete (created disabled); editor overloaded → notify managers. Runs exist because the seed passes through the engine.
8. **Saved views** (shared: Overdue, Awaiting Review, Due This Week, Unassigned; per-user "My Jobs"); dashboard layouts for the owner and `editor01`; ~70 % of notifications marked read.
9. Assertions: counts ≥ spec §39 minimums; `verifyDerived()` zero drift; every job has exactly one open transition; every revision numbered contiguously; prints counts per category.

---

## 13. Test plan

**Unit / integration (vitest, `src/**/*.test.ts`; DB tests use `makeTestDb()` → `:memory:` + schema + guards)**
- `lib/metrics.test.ts` — every formula in §8 on fixture rows incl. reattribution, due-date-changed-after-approval, completed-reopened-recompleted, workload weights/bands/hard caps, each bottleneck rule at boundaries.
- `lib/dates.test.ts` (exists) — org-tz day bounds, DST.
- `lib/workflow.test.ts` — graph helpers, kanban drop resolution (no-op, single, ambiguous, none).
- `server/auth/permissions.test.ts` — table-driven over `POLICY` × roles × {own, assigned, past, team, other, other-org, inactive}; snapshot of the matrix; `PERMISSIONS` and `POLICY` agree on which roles can ever act.
- `server/services/workflow.test.ts` — every edge in §4.2 succeeds with its side effects; every missing pair 422; override; `assigneeOnly`; one open transition; `sequence` contiguous; revision numbering never reused; resubmit resolves the open revision; approve snapshots `due_date_at_approval`/`was_on_time`; cancel closes sessions and revisions; reopen clears `completed_at` but keeps history; restore returns to the prior status; version conflict 409; review SLA default.
- `server/services/assignments.test.ts` — reassign in assigned/accepted → assigned; reassign mid in_progress → status unchanged + reattribution row + session closed + revision assignee moved; unassign → ready; decline; inactive target rejected; bulk reassign partial failure shape.
- `server/services/jobs.test.ts` — gap-free job numbers under 200 creates; per-field events; client/project consistency (trigger + service); pause/resume; `recomputeJobDerived` repairs a tampered pointer.
- `links/comments/notes/revisions/timeTracking/users/teams/clients/projects` service tests — supersession chain, 15-min edit window, mention must have job.view, note edit history, revision edit while open, one timer per user, deactivate → session_version bump + reassignment, last-owner guard, anonymise.
- `server/audit.integrity.test.ts` — source grep for forbidden mutations; triggers reject every forbidden statement; fill-once accepted exactly once; rollback leaves no event when a service throws mid-way.
- `server/automationEngine.test.ts` — each trigger/condition/action, dedupe per event, depth cap, SAVEPOINT isolation of a failing action, kill switch, pending replay.
- `server/sweep.test.ts` — overdue dedupe per (job, dueDate) and re-arm after deadline change; review overdue; workload band change emitted once; session auto-timeout.
- `server/queries/*.test.ts` — list filters/sorts/visibility per role (incl. team flags and management redaction), KPIs equal brute-force counts, search scoping, 404 for foreign ids.
- `db/verify.test.ts` — seed → zero drift; tamper a pointer → drift detected.
- `lib/validation/*.test.ts` — Zod schemas incl. URL protocol allowlist and workflow validation rules.

**E2E (Playwright, `e2e/`, fresh seeded DB; one spec per spec §40 item)**
`auth` · `permissions` (editor cannot open `/settings`, `/insights`, foreign job → 404; photographer sees only own unless flags; **second-org owner opening a Northlight id → 404, lists never include foreign rows**) · `job-create` · `assignment` (reassign mid-edit: old editor read-only, timer stopped, history shows both, stage re-attributed) · `status-flow` (full happy path across three roles) · `kanban` (drag, ambiguous drop picker, invalid drop) · `comments` (@mention notification deep-link, 15-min edit, placeholder after delete) · `revisions` (#1, #2, resubmit, approve, rate updates) · `links` (replace keeps history) · `notifications` · `activity-audit` (filters, before/after, integrity page 0 drift) · `workloads-analytics` (🔴 editor, bottleneck banners, range switch consistent with dashboard) · `filters-search-views` · `calendar-timeline` · `mobile` (390×844) · edge cases: `edge-deadline-change`, `edge-reopen` (completed-this-week counts once), `edge-editor-unavailable`, `edge-overdue` (fake clock → sweep → one event), `edge-concurrent-edit` (409 dialog), `edge-permission-loss`, `edge-link-change`, `edge-user-deactivated`, `edge-multiple-revisions`, `edge-pause` · `history-immutable` (no PATCH/DELETE routes for history; DB tamper throws).

CI: `typecheck → lint → test → build → db:reset → e2e`.

---

## 14. Decisions log (gaps closed by this synthesis)

| Topic | Decision |
|---|---|
| Reassignment mid-stage | Reattribution transition row (`kind='reattribution'`), status unchanged, new `editor_id_at_entry` (§4.5). |
| `jobs.client_id` duplication | Kept for indexed filtering; trigger enforces equality with `projects.client_id`; service re-syncs on project change. |
| `jobs.status_id` ∈ workflow / category match / needs transition row | Enforced by triggers, not only by services (§2.7). |
| Kanban ambiguous drop | Deterministic resolution + picker popover (§4.6). |
| Note history | In-place edit + `note.edited` events + `edit_count`; history drawer reads events. |
| Notification preferences | `user_notification_prefs` table; mandatory types bypass (§6). |
| One org per user / org-level timezone | Accepted for v1; users have no timezone override; a memberships table is the future path. |
| Overdue with no traffic / lost automation runs | Lazy sweep + pending-run replay (§7, §8); external scheduler may call the sweep. |
| Anonymisation | `anonymiseUser()` rewrites PII on `users` only; events untouched; actor-less summaries make feeds render correctly (§5). |
| Review deadline semantics | `review_due_date` defaults to submit + SLA; calendar, `review_overdue` bottleneck/notification only; never in Overdue/Due Today. |
| Pause work | `is_paused/paused_at` + events + chip; excluded from stalled rule. |
| Mention leak | Mention target must pass `job.view`; 422 otherwise. |
| Recipients for deadline/priority/reopen | §6 table. |
| Workload threshold re-firing | `user.workload_band_changed` emitted only on band change; notification dedupe per editor/band/day. |
| Completed-this-week after reopen | Latest completion only, shared `completedInRange()` (§8). |
| Bulk audit shape | One event per job + `batchId`; per-job tx; `BulkResult`. |
| Keyboard shortcuts | `KEYBOARD_SHORTCUTS` (§ constants), `/help` page. |
| Date storage | ISO UTC instants, end-of-day in org tz (CLAUDE.md rule 7). |
| Deadline encoding (as built) | `endOfCivilDayIso` returns 23:59:59.999 org-tz (inclusive). Every writer (jobs `deadlineToIso`, projects `_admin.toStoredDate`, seed, fixtures) uses it; readers compare instants with `<=`. |
| Proxy / unauthenticated API | `src/proxy.ts` only checks cookie presence. `/api/*` without a cookie → 401 JSON (not a redirect); `/api/auth/*` and `/design-system` are public; a dead session → `/login?expired=1`, where the proxy deletes the cookie (no redirect loop). |
| CSRF | Every non-GET/HEAD/OPTIONS route through `handle()` requires an `Origin` whose host matches `Host`/`X-Forwarded-Host`; a missing Origin is 403. Server actions rely on Next's own origin check. |
| Login rate limit | Failed attempts only, 5 per 15 min per email+IP + 20 per email, Postgres-backed (`auth_rate_limits`; shared by every serverless instance — docs/ACCOUNTS.md §6); success clears the email+IP key. `auth.login_failed` is audited only when the email matches an account. |
| Own password change | Allowed for any active user verified by the current password, without a POLICY check (`user.reset_password` would wrongly deny a manager acting on themself). |
| Editor scope on non-current jobs | `job.transition`, `comment.add`, `link.*`, `note.*` require being the **current** editor; past and team editors are read-only. |
| 403 vs 404 for in-org jobs | Queries (`loadVisibleJob`) return 404 for missing, foreign **and** same-org-but-invisible jobs. Collaboration services (comments/notes/links) return 403 for an in-org job the actor cannot act on (they must load it to evaluate the scoped permission); foreign ids are still 404. |
| Status-change engine details | Running timers close on **every** status transition (so `work_sessions.transition_id` is always the stage the timer ran in). Reattribution resets `jobs.status_entered_at` to the reattribution time (verify requires it to equal the open row). A target given by category resolves to the single allowed move; several → 422 `ambiguous_target`. |
| Workflow validation | `validateWorkflowDefinition` does not count edges into `cancelled` as a status's required outgoing edge (generated cancel edges would hide dead ends). In-use workflows reject only edits that add a critical issue. |
| Admin `expectedVersion` | Optional on admin mutations and on `assignEditor`/`unassignEditor`/`assignPhotographer` (checked only when sent → 409); job field and status mutations require it. Route handlers should always send it. |
| Automation enqueue hook | One hook: `recordEvent()` → `enqueueAutomations`. The workflow engine's `setAutomationEnqueuer` stays **unregistered** on purpose (it would only produce duplicates dropped by the unique key). Runs execute after commit via `withTxThenAutomations(ctx, fn)` / `runAutomationsAfterCommit`, `runPerJob({organisationId})` for bulk, and the sweep's 60 s replay. |
| Automation off switch / skipped runs | `automations_enabled = false` still queues runs, which are then `skipped` with a reason. Skipped runs exist only as `automation_runs` rows; `automation.ran` is written for matched (succeeded/failed) and crashed runs only. |
| Sweep endpoint | `POST /api/system/sweep` needs an owner/manager session + Origin. External schedulers use `GET|POST /api/system/cron/sweep` with `Authorization: Bearer $CRON_SECRET` (≥ 32 chars; 404 when unset, 401 on a wrong secret, constant-time compare; whitelisted in `src/proxy.ts`; sweeps every organisation; `src/server/cron.ts`). The `(app)` layout runs `lazySweep` via `after()`, at most once per 5 min per org (conditional update on `last_overdue_sweep_at`). |
| Touch targets | Shared `Button`, `IconButton`, `Input` and `Select` grow on `pointer: coarse` devices (`pointer-coarse:` variants): md 36→40 px, sm 32→36 px, icon buttons xs/sm/md 24/28/36→32/36/40 px. Desktop density is unchanged. |
| Database engine (Postgres cutover) | Production = **Supabase Postgres 17** through `postgres` (postgres-js) + `drizzle-orm/postgres-js` on `DATABASE_URL` = the **transaction pooler** (:6543, Supavisor), so the client runs with `prepare: false` (a transaction pooler cannot keep named prepared statements across checkouts) and a small pool (`max` 5 per server instance). Migrations, bulk loads and `db:verify:remote` use `DIRECT_URL` = the **session pooler** (:5432). Local dev, unit tests and local e2e = **PGlite** (Postgres 17 in WASM, in-process, `PGLITE_DATA_DIR`, auto-migrated on first open), so contributors need no database server and tests stay hermetic. Why: the SQLite file could not be shared between serverless instances (the old `/tmp` hosted demo was per-instance and ephemeral); Postgres gives one durable store, and PGlite keeps the same SQL dialect, triggers and transaction semantics locally. Everything is async (`await db.transaction(async (tx) => …)`); the rules are in `docs/POSTGRES-MIGRATION.md`. |
| Timestamps stay ISO text | Instants are still ISO-8601 UTC `text`, not `timestamptz`: every service, fixture, seed step and comparison already works on these strings (lexical order = time order for the fixed `…Z` format), the API returns them verbatim, and both drivers hand them back unchanged (no `Date`/timezone conversion differences between postgres-js and PGlite). Converting would have changed behaviour and API contracts during a storage-only migration. |
| Integrity triggers in Postgres | The SQLite `RAISE(ABORT)` triggers became PL/pgSQL in the custom migration `drizzle/0001_guards.sql` (same messages, SQLSTATE P0001; `isGuardViolation()` in `src/db/errors.ts`), plus `BEFORE TRUNCATE` guards because TRUNCATE skips row-level DELETE triggers. They are installed by the same migration on PGlite and Supabase. `db:seed:remote` loads historical rows with `SET LOCAL session_replication_role = replica` (guards and FK triggers off for that one transaction only). |
| Remote maintenance | `db:migrate:remote` / `db:seed:remote [-- --wipe]` / `db:verify:remote` read `.env.supabase` (gitignored, never auto-loaded by Next, values never printed). `db:seed:remote` seeds a fresh in-memory PGlite through the real services and copies every table in ONE target transaction (`jsonb_populate_recordset($1::text::jsonb)` per batch; identity sequences advanced), refusing a non-empty target unless `--wipe`. `REMOTE_ENV_FILE=<file>` points the same scripts (and `scripts/start-remote.mjs`, a `next start` launcher) at another database, e.g. a local Postgres used to rehearse a cutover. |
| Session secret | `SESSION_SECRET` (≥ 32 chars) is required in production. Outside production, without it, the server generates one once into `data/.session-secret` (gitignored), so `npm install → npm run db:reset → npm run dev` works with no env file. |
| `db:verify` deviations | `status_category` is checked against `workflow_statuses.category` of `jobs.status_id` (not the transition snapshot) so status recategorisation is legal. An active job held by an inactive editor is not flagged when that editor's latest `user.deactivated` event lists it in `metadata.openJobs` with `action: "kept"` (the §2.8 "unless flagged" exception). |
| Seed bootstrap | `organisations`, `organisation_settings` and each first owner are raw inserts (no organisation service exists); the owner's `user.created` event still goes through `recordEvent` (cause `seed`). Everything else uses the services. |
| Seed automations 3 and 4 | #3 is "Repeat revision → back to the original editor" (`revision_requested`, condition `revisionCount >= 2`, `assign_editor` target `original_editor`): with `previous_editor` and no condition ~60 runs failed with "no previous editor". #4 (approved → complete) is created disabled; toggling it mid-history auto-completed scripted jobs. |
| Seed workflows / numbers | "Quick Turnaround" = default graph with accepted/review/delivered **archived**; "Video Production" renames in_progress → Rough Cut, review → Client Review and adds `final_cut` (in_progress). Revision spike is ~33 in the last 7 days vs ~6.5/week (spec suggested 14 vs ~5); the review bottleneck counts 9 (one resubmitted job also waits > 24 h). All §39 minimums and §12 scenario checks pass. |
| Build tracing | `resolvePgliteDataDir()` / `migrationsFolder()` mark `process.cwd()` with `/*turbopackIgnore: true*/` so `next build` does not trace the whole project; `globals.css` has `@source not "../../data"` so Tailwind never scans the local database files. |
| API errors are always JSON | Every `src/app/api/**/route.ts` exports all five methods: the ones it does not implement are `methodNotAllowed([...])` → **405** `{ error: { code: "method_not_allowed" } }` + `Allow` header (Next's own 405 has no body). Unknown paths (the `[...path]` catch-all and bare `/api`) are a JSON **404** `not_found`; without a session the proxy answers a JSON **401** for `/api` and `/api/*`. `src/app/api/_lib/routes.test.ts` fails when a route file misses a method. |
| Drill-down filter params | KPI and bottleneck links add params with no facet control (`completedFrom/To`, `revisedFrom/To`, `statusEnteredBefore`, `isPaused`, `includeCancelled` = `JOB_SCOPE_KEYS`). The FilterBar shows each as a removable chip (labels in the org timezone), counts it in "Clear all (n)" and clears it — a drilled-down list never looks like plain All Work. A page that owns one of these keys with its own control passes `ownKeys` (Kanban: `includeCancelled`). |
| Page list vs strict API | `safeListJobs` (All Work, `/jobs`) first drops any param the strict `GET /api/jobs` schema would reject (e.g. `filter=foo`) and says so in the notice, so the rendered page and its "Load more" request always use the same, valid query. |
| Day bounds without a local midnight | `startOfCivilDayIso` = the FIRST instant of that civil date. When a DST jump happens at 00:00 (America/Santiago, America/Havana…) the day starts at the transition (01:00 local); found by a 1 s-resolution binary search only when the midnight fixed point is not the day's first instant. Intl formatters are cached per timezone. Verified for every day of 2026–2027 in 11 zones (`dates.test.ts`). |
| Editor pickers | Assign/reassign and revision-assignee dialogs list every active editor (`/api/users/options?role=editor`). `jobId` on that route keeps only people who can already view the job and is for @mentions only — using it in the assign dialog hid every new candidate. |
| Conflict dialog reload | "Reload latest" runs `router.refresh()` and closes the dialog in ONE transition, so the dialog stays (button busy) until the fresh version has rendered; an immediate retry no longer reuses the stale `expectedVersion`. |
| Command palette exact match | When search returns an exact job number, the palette highlights "Open PJ-… history" (controlled cmdk value), so Enter opens that job's History as the ↵ hint promises. |
| Tooltips at the layout edge | `Tooltip` takes `align` (`start`/`center`/`end`) for top/bottom placement; triggers at the right edge use `end` so the hidden tooltip never widens the page (Links tab "Remove link" at 1024 px). |
| Timeline filters before the cap | The Timeline board caps at 500 job rows. Its FilterBar filters (`q`, current editor, photographer, priority) are applied in SQL (`jobs.id IN (…)` via `jobFiltersWhere`) BEFORE the cap; filtering the capped rows in the page hid matching jobs once the window held more than 500 jobs. |
| Reports query-string form | `GET /api/reports?type=<kind>&range=…` (spec §36) is an alias of `/api/reports/:kind` (same JSON / CSV via `src/app/api/_lib/reports.ts`). |
| Integrity check snapshot | `verifyDerived` (`db:verify`, `GET /api/system/integrity`) runs all its reads in one `REPEATABLE READ, READ ONLY` transaction (one snapshot, one round trip per table even on Supabase); before, a job written between two of its queries on a busy server was reported as drift. |
| E2E layout | One helper module (`e2e/api.ts`: URL, seeded accounts, REST client, factories) and one fixtures module (`e2e/fixtures.ts`: role fixtures, HMR muting, UI/layout helpers). Main specs follow §13; `regression-*.spec.ts` cover audit regressions only (no overlap with main specs). Every spec creates its own data via the API, so the suite runs against a shared, already-seeded server (`E2E_BASE_URL`) as well as its own `data/pglite-e2e` database. Inside a test, `request.newContext()` inherits the role fixture's `storageState`; anonymous contexts pass `NO_SESSION` explicitly. |

### Open questions for build agents
See the orchestrator's `openQuestions` list; anything not answered here is decided by the owning agent and recorded in this file in the same PR.
