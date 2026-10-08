# Spec Checklist — Photographer Work Management Platform

Derived requirement-by-requirement from `docs/PRODUCT-SPEC.md` (40 sections + success criteria) and the non-negotiable rules in `CLAUDE.md`.
One line per atomic requirement. Id format `R<section>.<item>` (R00 = preamble, R41 = success criteria, R42 = CLAUDE.md architecture rules).
Tick `[x]` only with evidence (page visited, API call made, test name, or file:line). This document drives the final audit.

Line format: `- [ ] **Rxx.y** — requirement — _Verify:_ page/API/test`.
Verification legend: **UI** = manual page check · **API** = route handler call · **DB** = schema/query inspection · **Unit** = vitest · **E2E** = Playwright · **Code** = static code review.

---

## R00 — Preamble / Core positioning

- [ ] **R00.1** — Platform is a work-management system for photography businesses, not media storage — _Verify:_ Code: no file-upload routes for media; `grep -r multipart src/app/api` empty
- [ ] **R00.2** — No large photo/video uploads anywhere in the product — _Verify:_ UI: no upload controls on job pages; Code: no blob storage client
- [ ] **R00.3** — Jobs attach external URLs (Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom, gallery, any URL) — _Verify:_ UI: `/jobs/[id]` Links tab accepts arbitrary https URL; DB: `external_links` table
- [ ] **R00.4** — External link URL validated as a URL (Zod) before save — _Verify:_ Unit: `src/lib/validation/links.test.ts`; API: POST invalid URL → 400
- [ ] **R00.5** — Product is production-ready (builds, typechecks, lints, tests pass) — _Verify:_ `npm run build && npm run typecheck && npm run lint && npm run test`

## R01 — Core product concept (visibility & accountability)

- [ ] **R01.1** — Owner can see all active jobs at a glance — _Verify:_ UI: `/dashboard` Active Jobs KPI + `/workspace/all-work`
- [ ] **R01.2** — Responsible photographer visible per job — _Verify:_ UI: All Work table Photographer column; `/jobs/[id]` header
- [ ] **R01.3** — Assigned editor visible per job — _Verify:_ UI: All Work table Editor column; `/jobs/[id]` header
- [ ] **R01.4** — Current stage/status visible per job — _Verify:_ UI: Status badge on all job lists and detail
- [ ] **R01.5** — Jobs due today surfaced — _Verify:_ UI: dashboard Due Today KPI; filter `dueToday`
- [ ] **R01.6** — Overdue jobs surfaced — _Verify:_ UI: dashboard Overdue KPI; filter `overdue`
- [ ] **R01.7** — Completed jobs surfaced — _Verify:_ UI: Completed filter; Completed This Week KPI
- [ ] **R01.8** — Jobs waiting for review surfaced — _Verify:_ UI: Awaiting Review KPI + filter
- [ ] **R01.9** — Jobs sent back for revision surfaced — _Verify:_ UI: Revision Required KPI + filter
- [ ] **R01.10** — Each editor's workload visible — _Verify:_ UI: `/team/workloads`
- [ ] **R01.11** — Editor completion speed (turnaround) visible — _Verify:_ UI: `/team/performance` average turnaround column
- [ ] **R01.12** — Revision counts visible per job and per editor — _Verify:_ UI: job table Revision Count column; performance revision rate
- [ ] **R01.13** — What an editor worked on last week/month is answerable — _Verify:_ UI: `/team/editors/[id]` completed-this-week/month + history list
- [ ] **R01.14** — Who changed a job, when, and what changed is visible — _Verify:_ UI: `/jobs/[id]` Activity tab shows actor, timestamp, before/after
- [ ] **R01.15** — Submission timestamp visible per job — _Verify:_ UI: job History shows "submitted" event with time
- [ ] **R01.16** — Approval timestamp visible per job — _Verify:_ UI: job History shows "approved" event with time
- [ ] **R01.17** — Location of finished work visible per job — _Verify:_ UI: `/jobs/[id]` Finished Work section
- [ ] **R01.18** — What is blocking a job is visible — _Verify:_ UI: job detail shows blocker (awaiting review / revision / unassigned) indicator

## R02 — Users & roles

- [ ] **R02.1** — Four roles exist: owner, manager, photographer, editor — _Verify:_ DB: `users.role` enum; Code: `src/lib/types.ts` Role union
- [ ] **R02.2** — Owner/Admin can create jobs — _Verify:_ API: POST `/api/jobs` as owner → 201
- [ ] **R02.3** — Owner/Admin can assign photographers — _Verify:_ API: PATCH `/api/jobs/[id]` photographerId as owner → 200
- [ ] **R02.4** — Owner/Admin can assign editors — _Verify:_ API: POST `/api/jobs/[id]/assign` as owner → 200
- [ ] **R02.5** — Owner/Admin can reassign work — _Verify:_ API: assign to different editor → 200 + audit event `assignee_changed`
- [ ] **R02.6** — Owner/Admin can create workflows — _Verify:_ UI: `/settings/workflows` create
- [ ] **R02.7** — Owner/Admin can create custom statuses — _Verify:_ UI: `/settings/workflows` add status
- [ ] **R02.8** — Owner/Admin can set deadlines — _Verify:_ API: PATCH dueAt as owner → 200
- [ ] **R02.9** — Owner/Admin can view all jobs org-wide — _Verify:_ UI: All Work as owner shows every org job
- [ ] **R02.10** — Owner/Admin can view all employees — _Verify:_ UI: `/settings/users`, `/team/*`
- [ ] **R02.11** — Owner/Admin can view workloads, performance, activity history — _Verify:_ UI: `/team/workloads`, `/team/performance`, `/activity`
- [ ] **R02.12** — Owner/Admin can approve work — _Verify:_ API: transition → Approved as owner → 200
- [ ] **R02.13** — Owner/Admin can manage users (invite, edit role, deactivate) — _Verify:_ UI: `/settings/users`; API: POST/PATCH `/api/users`
- [ ] **R02.14** — Owner/Admin can manage permissions / roles — _Verify:_ UI: `/settings/roles`
- [ ] **R02.15** — Owner/Admin can manage teams — _Verify:_ UI: team membership editable in settings
- [ ] **R02.16** — Owner/Admin can manage org settings — _Verify:_ UI: `/settings/organisation`
- [ ] **R02.17** — Owner/Admin can view analytics — _Verify:_ UI: `/insights/analytics`
- [ ] **R02.18** — Photographer can create jobs — _Verify:_ API: POST `/api/jobs` as photographer → 201
- [ ] **R02.19** — Photographer sees own jobs (created or assigned as photographer) — _Verify:_ UI: `/workspace/my-work` as photographer
- [ ] **R02.20** — Photographer can view assigned editors on their jobs — _Verify:_ UI: job detail as photographer shows editor
- [ ] **R02.21** — Photographer can add job details — _Verify:_ API: PATCH own job → 200
- [ ] **R02.22** — Photographer can add external media links — _Verify:_ API: POST `/api/jobs/[id]/links` on own job → 201
- [ ] **R02.23** — Photographer can set deadlines on own jobs — _Verify:_ API: PATCH dueAt on own job → 200
- [ ] **R02.24** — Photographer can communicate with editors (comments) — _Verify:_ API: POST `/api/jobs/[id]/comments` on own job → 201
- [ ] **R02.25** — Photographer can review completed work — _Verify:_ UI: job in Submitted for Review shows Approve / Request Revision
- [ ] **R02.26** — Photographer can request revisions — _Verify:_ API: POST `/api/jobs/[id]/revisions` as photographer → 201
- [ ] **R02.27** — Photographer can approve work — _Verify:_ API: transition → Approved as photographer on own job → 200
- [ ] **R02.28** — Photographer sees job history — _Verify:_ UI: Activity/History tab visible to photographer
- [ ] **R02.29** — Photographer team-wide workload visibility is permission-gated — _Verify:_ Code: `permissions.ts` `canViewTeamWorkloads`; UI: hidden when not granted
- [ ] **R02.30** — Photographer cannot see jobs they are not on (unless permitted) — _Verify:_ API: GET `/api/jobs/[otherId]` as photographer → 403/404
- [ ] **R02.31** — Editor has a focused "My Work" workspace — _Verify:_ UI: `/workspace/my-work` as editor
- [ ] **R02.32** — Editor My Work shows assigned jobs only — _Verify:_ API: GET `/api/jobs?mine=1` as editor returns only assigned
- [ ] **R02.33** — Editor card shows priority, due date, client/project, photographer — _Verify:_ UI: My Work card fields
- [ ] **R02.34** — Editor card shows job type, current status, estimated workload — _Verify:_ UI: My Work card fields
- [ ] **R02.35** — Editor card shows notes, external media link, delivery link, revision requests — _Verify:_ UI: My Work card fields
- [ ] **R02.36** — Editor can start work — _Verify:_ API: POST `/api/jobs/[id]/transition` → In Progress as editor → 200
- [ ] **R02.37** — Editor can pause work — _Verify:_ API: POST `/api/jobs/[id]/work-sessions` pause → 200
- [ ] **R02.38** — Editor can mark complete / submit for review — _Verify:_ API: transition → Submitted for Review as editor → 200
- [ ] **R02.39** — Editor can add notes (editor notes) — _Verify:_ API: PATCH editorNotes as editor → 200
- [ ] **R02.40** — Editor can add external finished-work links — _Verify:_ API: POST links kind=finished as editor → 201
- [ ] **R02.41** — Editor can comment / ask questions / request clarification — _Verify:_ API: POST comments as editor → 201
- [ ] **R02.42** — Editor can see revision requests on their jobs — _Verify:_ UI: Revisions tab visible to editor
- [ ] **R02.43** — Editor can resubmit after revision — _Verify:_ API: transition → Resubmitted as editor → 200
- [ ] **R02.44** — Editor cannot change priority / deadline / assignee / photographer — _Verify:_ API: PATCH those fields as editor → 403
- [ ] **R02.45** — Editor cannot approve work — _Verify:_ API: transition → Approved as editor → 403
- [ ] **R02.46** — Editor cannot create jobs — _Verify:_ API: POST `/api/jobs` as editor → 403
- [ ] **R02.47** — Editor cannot delete/cancel jobs — _Verify:_ API: transition → Cancelled as editor → 403
- [ ] **R02.48** — Editor cannot access settings pages — _Verify:_ UI: `/settings/*` as editor → redirect/403

## R03 — Main dashboard

- [ ] **R03.1** — Dashboard page exists at app root for authenticated users — _Verify:_ UI: `/dashboard` (or `/`) renders
- [ ] **R03.2** — KPI card: Active Jobs (count correct) — _Verify:_ UI + DB: count of non-terminal jobs matches
- [ ] **R03.3** — KPI card: Due Today (org timezone) — _Verify:_ UI + Unit: `dueToday` uses org tz boundaries
- [ ] **R03.4** — KPI card: Overdue — _Verify:_ UI + Unit: dueAt < now and not completed/cancelled
- [ ] **R03.5** — KPI card: Awaiting Editor (unassigned / Ready for Assignment) — _Verify:_ UI + DB count
- [ ] **R03.6** — KPI card: In Editing (In Progress / Accepted) — _Verify:_ UI + DB count
- [ ] **R03.7** — KPI card: Awaiting Review (Submitted / Resubmitted / Review Required) — _Verify:_ UI + DB count
- [ ] **R03.8** — KPI card: Revision Required — _Verify:_ UI + DB count
- [ ] **R03.9** — KPI card: Completed This Week (org tz week) — _Verify:_ UI + Unit
- [ ] **R03.10** — KPI cards link to the corresponding filtered job list — _Verify:_ UI: click card → All Work with filter applied
- [ ] **R03.11** — Workload overview lists every active editor — _Verify:_ UI: dashboard editor workload table
- [ ] **R03.12** — Per-editor: Assigned count — _Verify:_ UI + DB
- [ ] **R03.13** — Per-editor: In Progress count — _Verify:_ UI + DB
- [ ] **R03.14** — Per-editor: Due Today count — _Verify:_ UI + DB
- [ ] **R03.15** — Per-editor: Overdue count — _Verify:_ UI + DB
- [ ] **R03.16** — Per-editor: Completed This Week count — _Verify:_ UI + DB
- [ ] **R03.17** — Per-editor: Revision Rate (%) — _Verify:_ UI + Unit: revisions / completed
- [ ] **R03.18** — Capacity indicator Healthy / Near capacity / Overloaded per editor — _Verify:_ UI: badge; Unit: threshold function
- [ ] **R03.19** — Capacity thresholds configurable (org setting or constant) — _Verify:_ Code: `src/lib/constants.ts` or org settings
- [ ] **R03.20** — Dashboard scoped by role (editor sees own, not org-wide KPIs) — _Verify:_ UI: login as editor → personal dashboard
- [ ] **R03.21** — Dashboard has loading state — _Verify:_ Code: `src/app/(app)/dashboard/loading.tsx`
- [ ] **R03.22** — Dashboard has error boundary — _Verify:_ Code: `error.tsx` present

## R04 — Job management (core object)

- [ ] **R04.1** — Job has internal id (nanoid) and human jobNumber `PJ-0001` style — _Verify:_ DB: `jobs.id`, `jobs.jobNumber` unique per org
- [ ] **R04.2** — jobNumber auto-increments per organisation without gaps/duplicates — _Verify:_ Unit: concurrent creates yield unique numbers
- [ ] **R04.3** — Job name (required) — _Verify:_ API: POST without name → 400
- [ ] **R04.4** — Job client (FK) — _Verify:_ DB: `jobs.clientId` → clients
- [ ] **R04.5** — Job project (FK, belongs to client) — _Verify:_ DB: `jobs.projectId`; Unit: project.clientId must match
- [ ] **R04.6** — Job photographer (FK users) — _Verify:_ DB: `jobs.photographerId`
- [ ] **R04.7** — Job editor (FK users, nullable) — _Verify:_ DB: `jobs.editorId`
- [ ] **R04.8** — Job type (FK job_types) — _Verify:_ DB: `jobs.jobTypeId`
- [ ] **R04.9** — Priority enum (low / normal / high / urgent) — _Verify:_ DB + Zod enum
- [ ] **R04.10** — Created date auto-set — _Verify:_ DB: `createdAt`
- [ ] **R04.11** — Shoot date — _Verify:_ DB: `shootAt`
- [ ] **R04.12** — Due date — _Verify:_ DB: `dueAt`
- [ ] **R04.13** — Completion date set on completion only — _Verify:_ Unit: transition → Completed sets `completedAt`; reopen clears or keeps per spec
- [ ] **R04.14** — Current status (FK statuses) — _Verify:_ DB: `jobs.statusId`
- [ ] **R04.15** — Previous status retrievable — _Verify:_ DB: `jobs.previousStatusId` or derived from events
- [ ] **R04.16** — Status history (all transitions) — _Verify:_ DB: `activity_events` type `status_changed`; UI: History tab
- [ ] **R04.17** — Current assignee — _Verify:_ DB: `jobs.editorId` / `assignments` current row
- [ ] **R04.18** — Previous assignee retrievable — _Verify:_ DB: `assignments` history or events
- [ ] **R04.19** — Review status (none / pending / approved / revision) — _Verify:_ DB: field or derived; UI badge
- [ ] **R04.20** — Revision count stored and incremented — _Verify:_ DB: `jobs.revisionCount`; Unit: request revision increments
- [ ] **R04.21** — Approval status (approvedAt, approvedBy) — _Verify:_ DB: fields; UI shows approver
- [ ] **R04.22** — Link slot: raw files — _Verify:_ UI: Links tab kind=raw
- [ ] **R04.23** — Link slot: editing workspace — _Verify:_ UI: kind=workspace
- [ ] **R04.24** — Link slot: finished files — _Verify:_ UI: kind=finished
- [ ] **R04.25** — Link slot: gallery — _Verify:_ UI: kind=gallery
- [ ] **R04.26** — Link slot: client delivery — _Verify:_ UI: kind=delivery
- [ ] **R04.27** — Link slot: reference material — _Verify:_ UI: kind=reference
- [ ] **R04.28** — Structured note: photographer notes — _Verify:_ DB/UI field
- [ ] **R04.29** — Structured note: editor notes — _Verify:_ DB/UI field
- [ ] **R04.30** — Structured note: internal notes (hidden from editors) — _Verify:_ API: GET job as editor omits internalNotes
- [ ] **R04.31** — Structured note: revision notes — _Verify:_ DB/UI (revisions table + summary)
- [ ] **R04.32** — Structured note: client notes — _Verify:_ DB/UI field
- [ ] **R04.33** — Create job page/dialog with all basic fields — _Verify:_ UI: `/jobs/new`
- [ ] **R04.34** — Edit job (PATCH) records before/after for each changed field — _Verify:_ API + DB: `activity_events` rows per field
- [ ] **R04.35** — Job detail page `/jobs/[id]` — _Verify:_ UI renders header, fields, tabs
- [ ] **R04.36** — Job detail accessible by jobNumber (`/jobs/PJ-0042`) or search — _Verify:_ UI/API
- [ ] **R04.37** — Job list page `/jobs` with loading/empty/error states — _Verify:_ Code: `loading.tsx`, empty component, `error.tsx`
- [ ] **R04.38** — Jobs are org-scoped (cannot read another org's job) — _Verify:_ API: cross-org id → 404

## R05 — Job status workflow

- [ ] **R05.1** — Workflows are configurable per organisation — _Verify:_ DB: `workflows`, `statuses` tables
- [ ] **R05.2** — Default workflow seeded with 12 statuses in order — _Verify:_ DB: seed — New, Ready for Assignment, Assigned, Accepted, In Progress, Submitted for Review, Review Required, Revision Required, Resubmitted, Approved, Delivered, Completed
- [ ] **R05.3** — Cancelled status exists (terminal) — _Verify:_ DB: seed
- [ ] **R05.4** — Each status has a category/kind (new, assigned, editing, review, revision, approved, done, cancelled) — _Verify:_ DB: `statuses.category`; drives KPIs/kanban
- [ ] **R05.5** — Allowed transitions defined (or any-to-any with permission) — _Verify:_ Code: `workflow.ts` transition table; Unit
- [ ] **R05.6** — Admin can add a custom status — _Verify:_ UI: `/settings/workflows`; API: POST `/api/workflows/[id]/statuses`
- [ ] **R05.7** — Admin can rename / reorder / recolour statuses — _Verify:_ UI + API PATCH
- [ ] **R05.8** — Admin cannot delete a status in use (or must remap) — _Verify:_ API: DELETE used status → 409
- [ ] **R05.9** — Every status change recorded with actor, time, from, to — _Verify:_ DB: `activity_events` type `status_changed` previousValue/newValue
- [ ] **R05.10** — Status change rendered as "10:42 AM — John Smith changed status from A → B" — _Verify:_ UI: History tab format
- [ ] **R05.11** — Status history never deleted when status config changes — _Verify:_ Unit: rename status → old events keep original label snapshot
- [ ] **R05.12** — All status changes go through `transitionJobStatus()` — _Verify:_ Code: `grep -rn "statusId" src/server/services` only in workflow.ts
- [ ] **R05.13** — Transition sets `previousStatusId` — _Verify:_ Unit
- [ ] **R05.14** — Transition into Completed sets completedAt — _Verify:_ Unit
- [ ] **R05.15** — Transition into Submitted for Review sets submittedAt — _Verify:_ Unit
- [ ] **R05.16** — Transition into Approved sets approvedAt/approvedBy — _Verify:_ Unit
- [ ] **R05.17** — Transition into Revision Required increments revisionCount (via revision service) — _Verify:_ Unit
- [ ] **R05.18** — Invalid transition rejected with 400 and no side effects — _Verify:_ Unit + API

## R06 — Complete audit trail

- [ ] **R06.1** — Event: job created — _Verify:_ DB: create job → `job_created` row
- [ ] **R06.2** — Event: job edited (per field) — _Verify:_ DB: `job_updated` rows with field name
- [ ] **R06.3** — Event: assignee changed — _Verify:_ DB: `assignee_changed`
- [ ] **R06.4** — Event: status changed — _Verify:_ DB: `status_changed`
- [ ] **R06.5** — Event: priority changed — _Verify:_ DB: `priority_changed`
- [ ] **R06.6** — Event: deadline changed — _Verify:_ DB: `deadline_changed`
- [ ] **R06.7** — Event: note added/edited — _Verify:_ DB: `note_updated`
- [ ] **R06.8** — Event: comment added — _Verify:_ DB: `comment_added`
- [ ] **R06.9** — Event: link added / changed / removed — _Verify:_ DB: `link_added`, `link_updated`, `link_removed`
- [ ] **R06.10** — Event: work started — _Verify:_ DB: `work_started`
- [ ] **R06.11** — Event: work paused — _Verify:_ DB: `work_paused`
- [ ] **R06.12** — Event: work submitted — _Verify:_ DB: `work_submitted`
- [ ] **R06.13** — Event: work approved — _Verify:_ DB: `work_approved`
- [ ] **R06.14** — Event: revision requested — _Verify:_ DB: `revision_requested`
- [ ] **R06.15** — Event: revision completed / resubmitted — _Verify:_ DB: `revision_completed`
- [ ] **R06.16** — Event: job completed — _Verify:_ DB: `job_completed`
- [ ] **R06.17** — Event: job reopened — _Verify:_ DB: `job_reopened`
- [ ] **R06.18** — Every event has Who (userId) — _Verify:_ DB: NOT NULL (system events use system actor)
- [ ] **R06.19** — Every event has What (eventType + action) — _Verify:_ DB columns
- [ ] **R06.20** — Every event has When (ISO UTC createdAt) — _Verify:_ DB column
- [ ] **R06.21** — Every event has Before (previousValue) — _Verify:_ DB column (nullable for creates)
- [ ] **R06.22** — Every event has After (newValue) — _Verify:_ DB column
- [ ] **R06.23** — Events written in same transaction as mutation — _Verify:_ Code: `recordEvent(tx, …)` inside `db.transaction` in every service
- [ ] **R06.24** — Failed mutation writes no event (rollback) — _Verify:_ Unit: throw after mutation → 0 events

## R07 — Editor workspace (My Queue)

- [ ] **R07.1** — My Work page for editors at `/workspace/my-work` — _Verify:_ UI
- [ ] **R07.2** — Section: Due Today — _Verify:_ UI + Unit grouping function
- [ ] **R07.3** — Section: Due Tomorrow — _Verify:_ UI + Unit
- [ ] **R07.4** — Section: Upcoming — _Verify:_ UI + Unit
- [ ] **R07.5** — Section: Overdue — _Verify:_ UI + Unit
- [ ] **R07.6** — Section: Waiting for Review — _Verify:_ UI + Unit
- [ ] **R07.7** — Section: Revision Required — _Verify:_ UI + Unit
- [ ] **R07.8** — A job appears in exactly one section (precedence defined) — _Verify:_ Unit: grouping precedence test
- [ ] **R07.9** — Card: job name — _Verify:_ UI
- [ ] **R07.10** — Card: client — _Verify:_ UI
- [ ] **R07.11** — Card: photographer — _Verify:_ UI
- [ ] **R07.12** — Card: due date — _Verify:_ UI
- [ ] **R07.13** — Card: priority — _Verify:_ UI
- [ ] **R07.14** — Card: status — _Verify:_ UI
- [ ] **R07.15** — Card: time in current status — _Verify:_ UI + Unit: from last status_changed event
- [ ] **R07.16** — Card: revision count — _Verify:_ UI
- [ ] **R07.17** — Card: external work link — _Verify:_ UI
- [ ] **R07.18** — Card: notes — _Verify:_ UI
- [ ] **R07.19** — Quick action: Start — _Verify:_ UI → transition In Progress
- [ ] **R07.20** — Quick action: Submit — _Verify:_ UI → transition Submitted for Review
- [ ] **R07.21** — Quick action: Complete (where allowed) — _Verify:_ UI → transition
- [ ] **R07.22** — Quick actions only show when transition valid for role — _Verify:_ UI + Unit
- [ ] **R07.23** — Empty state when editor has no jobs — _Verify:_ UI

## R08 — Photographer / Owner workspace (All Work)

- [ ] **R08.1** — All Work table at `/workspace/all-work` — _Verify:_ UI
- [ ] **R08.2** — Column: Job (name + jobNumber) — _Verify:_ UI
- [ ] **R08.3** — Column: Client — _Verify:_ UI
- [ ] **R08.4** — Column: Photographer — _Verify:_ UI
- [ ] **R08.5** — Column: Editor — _Verify:_ UI
- [ ] **R08.6** — Column: Status — _Verify:_ UI
- [ ] **R08.7** — Column: Priority — _Verify:_ UI
- [ ] **R08.8** — Column: Created — _Verify:_ UI
- [ ] **R08.9** — Column: Shoot Date — _Verify:_ UI
- [ ] **R08.10** — Column: Due Date — _Verify:_ UI
- [ ] **R08.11** — Column: Days Remaining (negative = overdue) — _Verify:_ UI + Unit `daysRemaining()` org tz
- [ ] **R08.12** — Column: Revision Count — _Verify:_ UI
- [ ] **R08.13** — Column: Last Activity (timestamp of latest event) — _Verify:_ UI + DB
- [ ] **R08.14** — Column: Completion % (status position in workflow) — _Verify:_ UI + Unit
- [ ] **R08.15** — Column: External Link — _Verify:_ UI
- [ ] **R08.16** — Sorting on every column — _Verify:_ UI/API: `?sort=dueAt&dir=asc`
- [ ] **R08.17** — Filtering (see R20) — _Verify:_ UI/API
- [ ] **R08.18** — Searching within table — _Verify:_ UI/API `?q=`
- [ ] **R08.19** — Grouping (by status / editor / photographer / client) — _Verify:_ UI: `?groupBy=`
- [ ] **R08.20** — Column show/hide customisation — _Verify:_ UI: column picker
- [ ] **R08.21** — Saved views (persisted per user) — _Verify:_ DB: `saved_views`; UI: save/load
- [ ] **R08.22** — Row click → job detail (progressive disclosure) — _Verify:_ UI
- [ ] **R08.23** — Pagination or virtualisation for 150+ jobs — _Verify:_ UI/API `?page=`
- [ ] **R08.24** — Team Work view (`/workspace/team-work`) scoped by permission — _Verify:_ UI

## R09 — Kanban view

- [ ] **R09.1** — Kanban page `/workspace/kanban` — _Verify:_ UI
- [ ] **R09.2** — Columns: New, Assigned, In Progress, Review, Revision, Approved, Completed (by status category) — _Verify:_ UI
- [ ] **R09.3** — Drag card between columns (dnd-kit) — _Verify:_ E2E
- [ ] **R09.4** — Drop triggers backend transition (not local state only) — _Verify:_ API call observed; DB status changed
- [ ] **R09.5** — Drop records activity event with user + timestamp — _Verify:_ DB
- [ ] **R09.6** — Invalid/forbidden drop reverts card and shows error — _Verify:_ E2E
- [ ] **R09.7** — Cards show name, client, editor, due, priority — _Verify:_ UI
- [ ] **R09.8** — Kanban respects role scoping (editor sees own jobs) — _Verify:_ UI as editor
- [ ] **R09.9** — Kanban column counts shown — _Verify:_ UI

## R10 — Calendar view

- [ ] **R10.1** — Calendar page `/workspace/calendar` — _Verify:_ UI
- [ ] **R10.2** — Shows shoot dates — _Verify:_ UI
- [ ] **R10.3** — Shows editing deadlines (dueAt) — _Verify:_ UI
- [ ] **R10.4** — Shows review deadlines — _Verify:_ UI (reviewDueAt or derived)
- [ ] **R10.5** — Shows delivery deadlines — _Verify:_ UI (deliveryDueAt or derived)
- [ ] **R10.6** — Day view — _Verify:_ UI toggle
- [ ] **R10.7** — Week view — _Verify:_ UI toggle
- [ ] **R10.8** — Month view — _Verify:_ UI toggle
- [ ] **R10.9** — Colour by status — _Verify:_ UI toggle
- [ ] **R10.10** — Colour by priority — _Verify:_ UI toggle
- [ ] **R10.11** — Colour by overdue — _Verify:_ UI toggle
- [ ] **R10.12** — Colour by assigned editor — _Verify:_ UI toggle
- [ ] **R10.13** — Dates rendered in org timezone — _Verify:_ Unit: `src/lib/dates.ts`
- [ ] **R10.14** — Event click → job detail — _Verify:_ UI

## R11 — Timeline / Gantt view

- [ ] **R11.1** — Timeline page `/workspace/timeline` — _Verify:_ UI
- [ ] **R11.2** — Stages: Job → Assignment → Editing → Review → Revision → Approval → Delivery — _Verify:_ UI bars per stage derived from status events
- [ ] **R11.3** — Stage durations computed from status_changed events — _Verify:_ Unit: `stageDurations()`
- [ ] **R11.4** — Bottleneck stages highlighted (longest stage / over threshold) — _Verify:_ UI
- [ ] **R11.5** — Horizontal scroll / zoom range — _Verify:_ UI

## R12 — Editor workload management

- [ ] **R12.1** — Workloads page `/team/workloads` — _Verify:_ UI
- [ ] **R12.2** — Columns: Editor, Active, Due Today, Overdue, Completed, Revision Rate — _Verify:_ UI + DB
- [ ] **R12.3** — Click editor → detail page `/team/editors/[id]` — _Verify:_ UI
- [ ] **R12.4** — Detail: current jobs list — _Verify:_ UI
- [ ] **R12.5** — Detail: completed jobs list — _Verify:_ UI
- [ ] **R12.6** — Detail: overdue jobs list — _Verify:_ UI
- [ ] **R12.7** — Detail: average completion time — _Verify:_ UI + Unit
- [ ] **R12.8** — Detail: average time per stage — _Verify:_ UI + Unit
- [ ] **R12.9** — Detail: revision rate — _Verify:_ UI + Unit
- [ ] **R12.10** — Detail: completed this week / this month — _Verify:_ UI + Unit (org tz)
- [ ] **R12.11** — Detail: current + historical workload (chart) — _Verify:_ UI: recharts
- [ ] **R12.12** — Workload metrics computed server-side in `src/server/queries/workload.ts` — _Verify:_ Code

## R13 — Performance analytics

- [ ] **R13.1** — Performance page `/team/performance` — _Verify:_ UI
- [ ] **R13.2** — Metric: jobs completed — _Verify:_ UI + Unit
- [ ] **R13.3** — Metric: average turnaround (assigned → completed) — _Verify:_ UI + Unit
- [ ] **R13.4** — Metric: average editing time (started → submitted) — _Verify:_ UI + Unit
- [ ] **R13.5** — Metric: average review time (submitted → approved/revision) — _Verify:_ UI + Unit
- [ ] **R13.6** — Metric: revision rate — _Verify:_ UI + Unit
- [ ] **R13.7** — Metric: on-time % (completedAt ≤ dueAt) — _Verify:_ UI + Unit
- [ ] **R13.8** — Metric: overdue count — _Verify:_ UI
- [ ] **R13.9** — Metric: active count — _Verify:_ UI
- [ ] **R13.10** — Metric: completed this week / month — _Verify:_ UI
- [ ] **R13.11** — Metrics are operational (derived from events), not editable — _Verify:_ Code: no write path
- [ ] **R13.12** — Date range selector — _Verify:_ UI

## R14 — Bottleneck detection

- [ ] **R14.1** — Bottlenecks page `/insights/bottlenecks` — _Verify:_ UI
- [ ] **R14.2** — Review bottleneck: N jobs waiting for review > 24h — _Verify:_ Unit: `detectBottlenecks()`
- [ ] **R14.3** — Editing bottleneck: editor with N active jobs, M due within 48h — _Verify:_ Unit
- [ ] **R14.4** — Revision bottleneck: N jobs required revisions this week — _Verify:_ Unit
- [ ] **R14.5** — Warnings rendered on management dashboard — _Verify:_ UI: `/dashboard` bottleneck widget
- [ ] **R14.6** — Thresholds configurable or in constants — _Verify:_ Code
- [ ] **R14.7** — Bottleneck warnings hidden from editors — _Verify:_ UI as editor
- [ ] **R14.8** — Each warning links to the affected job list / editor — _Verify:_ UI

## R15 — Time tracking (optional, admin-enabled)

- [ ] **R15.1** — Org setting `timeTrackingEnabled` toggle — _Verify:_ UI: `/settings/organisation`; DB
- [ ] **R15.2** — Start session (editor on own job) — _Verify:_ API: POST `/api/jobs/[id]/work-sessions` start
- [ ] **R15.3** — Pause session — _Verify:_ API: pause
- [ ] **R15.4** — Stop session — _Verify:_ API: stop
- [ ] **R15.5** — Only one open session per user at a time — _Verify:_ Unit: start twice → 409
- [ ] **R15.6** — Total active time per job — _Verify:_ UI: job detail; Unit
- [ ] **R15.7** — Session list per job — _Verify:_ UI
- [ ] **R15.8** — Time per workflow stage — _Verify:_ UI + Unit (session.statusId snapshot)
- [ ] **R15.9** — Time tracking UI hidden when disabled — _Verify:_ UI
- [ ] **R15.10** — API rejects sessions when disabled — _Verify:_ API → 403/400
- [ ] **R15.11** — Sessions write audit events — _Verify:_ DB

## R16 — Comments & communication

- [ ] **R16.1** — Add comment on job — _Verify:_ API: POST `/api/jobs/[id]/comments`
- [ ] **R16.2** — Reply to comment (parentId threading) — _Verify:_ DB: `comments.parentId`; UI nested
- [ ] **R16.3** — @mention users (parsed, stored) — _Verify:_ DB: `comment_mentions` or JSON; Unit parser
- [ ] **R16.4** — @mention triggers notification — _Verify:_ DB: notification type `mentioned`
- [ ] **R16.5** — Comment types: note / question / revision response — _Verify:_ DB: `comments.kind`
- [ ] **R16.6** — Comments cannot be deleted (permanent history) — _Verify:_ Code: no DELETE route; API DELETE → 405
- [ ] **R16.7** — Comment edit (if any) keeps original in audit — _Verify:_ Code/DB: event with before/after or no edit
- [ ] **R16.8** — Comments org-scoped and job-scoped — _Verify:_ API cross-org → 404
- [ ] **R16.9** — Comments visible on job detail Comments tab — _Verify:_ UI
- [ ] **R16.10** — Comment body validated (non-empty, max length) — _Verify:_ Unit Zod

## R17 — Revision management

- [ ] **R17.1** — Revision entity with reason — _Verify:_ DB: `revisions.reason`
- [ ] **R17.2** — Revision description — _Verify:_ DB
- [ ] **R17.3** — Revision priority — _Verify:_ DB
- [ ] **R17.4** — Revision specific instructions — _Verify:_ DB
- [ ] **R17.5** — Revision assigned-to (defaults to current editor) — _Verify:_ DB: `assignedToId`
- [ ] **R17.6** — Revision due date — _Verify:_ DB: `dueAt`
- [ ] **R17.7** — Sequential number per job (#1, #2, #3…) — _Verify:_ Unit: `revisionNumber` increments
- [ ] **R17.8** — Revisions never overwritten or deleted — _Verify:_ Code: no update/delete of core fields; API DELETE → 405
- [ ] **R17.9** — Request revision moves job to Revision Required via workflow — _Verify:_ Unit
- [ ] **R17.10** — Revision status lifecycle (open → resolved) — _Verify:_ DB: `revisions.status`, `resolvedAt`
- [ ] **R17.11** — Resubmit resolves current open revision — _Verify:_ Unit
- [ ] **R17.12** — Revisions tab on job detail lists all numbered — _Verify:_ UI
- [ ] **R17.13** — Only photographer/owner/manager can request revision — _Verify:_ API as editor → 403
- [ ] **R17.14** — Revision request writes audit event + notification — _Verify:_ DB

## R18 — Job history

- [ ] **R18.1** — History tab on job detail — _Verify:_ UI
- [ ] **R18.2** — Chronological timeline (oldest → newest or reversed, consistent) — _Verify:_ UI
- [ ] **R18.3** — Milestones: created, assigned, accepted, started, submitted, revision requested, resubmitted, approved, completed — _Verify:_ UI shows each with timestamp
- [ ] **R18.4** — Timeline visually distinguishes event types (icon/colour) — _Verify:_ UI
- [ ] **R18.5** — History served from `activity_events` (not separate store) — _Verify:_ Code: `src/server/queries/activity.ts`

## R19 — Search

- [ ] **R19.1** — Global search (command palette, cmdk, Ctrl/Cmd+K) — _Verify:_ UI
- [ ] **R19.2** — Search API `/api/search?q=` — _Verify:_ API
- [ ] **R19.3** — Matches job names — _Verify:_ API
- [ ] **R19.4** — Matches clients — _Verify:_ API
- [ ] **R19.5** — Matches photographers — _Verify:_ API
- [ ] **R19.6** — Matches editors — _Verify:_ API
- [ ] **R19.7** — Matches job IDs / jobNumber — _Verify:_ API: `PJ-0042`
- [ ] **R19.8** — Matches status names — _Verify:_ API
- [ ] **R19.9** — Matches notes — _Verify:_ API
- [ ] **R19.10** — Matches comments — _Verify:_ API
- [ ] **R19.11** — Search by job ID opens job with full history — _Verify:_ UI
- [ ] **R19.12** — Search results org-scoped and permission-scoped — _Verify:_ API as editor excludes unassigned jobs

## R20 — Filters

- [ ] **R20.1** — Filter: My Jobs — _Verify:_ API `?filter=mine`
- [ ] **R20.2** — Filter: Unassigned — _Verify:_ API
- [ ] **R20.3** — Filter: Overdue — _Verify:_ API
- [ ] **R20.4** — Filter: Due Today — _Verify:_ API
- [ ] **R20.5** — Filter: Due This Week — _Verify:_ API
- [ ] **R20.6** — Filter: Awaiting Review — _Verify:_ API
- [ ] **R20.7** — Filter: Revision Required — _Verify:_ API
- [ ] **R20.8** — Filter: Completed — _Verify:_ API
- [ ] **R20.9** — Filter by Photographer — _Verify:_ API `?photographerId=`
- [ ] **R20.10** — Filter by Editor — _Verify:_ API `?editorId=`
- [ ] **R20.11** — Filter by Client — _Verify:_ API `?clientId=`
- [ ] **R20.12** — Filter by Job Type — _Verify:_ API `?jobTypeId=`
- [ ] **R20.13** — Filter by Priority — _Verify:_ API `?priority=`
- [ ] **R20.14** — Filters combinable — _Verify:_ API multiple params
- [ ] **R20.15** — Filters reflected in URL (shareable) — _Verify:_ UI
- [ ] **R20.16** — Saved custom views store filters + sort + columns + grouping — _Verify:_ DB: `saved_views.config` JSON
- [ ] **R20.17** — Saved views CRUD API — _Verify:_ API `/api/saved-views`
- [ ] **R20.18** — Filter params validated with Zod — _Verify:_ Unit

## R21 — Notifications

- [ ] **R21.1** — Notification on: assigned — _Verify:_ DB: type `assigned` after assign
- [ ] **R21.2** — Notification on: deadline changed — _Verify:_ DB
- [ ] **R21.3** — Notification on: comment on your job — _Verify:_ DB
- [ ] **R21.4** — Notification on: revision requested — _Verify:_ DB
- [ ] **R21.5** — Notification on: work submitted (to photographer) — _Verify:_ DB
- [ ] **R21.6** — Notification on: work approved (to editor) — _Verify:_ DB
- [ ] **R21.7** — Notification on: overdue — _Verify:_ DB (check on load or scheduled)
- [ ] **R21.8** — Notification on: mentioned — _Verify:_ DB
- [ ] **R21.9** — Notification on: reassigned (old + new editor) — _Verify:_ DB
- [ ] **R21.10** — In-app notification centre (bell + list) — _Verify:_ UI `/notifications` + topbar
- [ ] **R21.11** — Unread count badge — _Verify:_ UI
- [ ] **R21.12** — Mark one read — _Verify:_ API PATCH `/api/notifications/[id]`
- [ ] **R21.13** — Mark all read — _Verify:_ API POST `/api/notifications/read-all`
- [ ] **R21.14** — Notification links to job — _Verify:_ UI
- [ ] **R21.15** — Notifications org + user scoped — _Verify:_ API other user's id → 404
- [ ] **R21.16** — Email/push channel abstraction (interface present, not required to send) — _Verify:_ Code: `src/server/services/notifications.ts` channel hook
- [ ] **R21.17** — Notification preferences page `/settings/notifications` — _Verify:_ UI
- [ ] **R21.18** — Actor does not get notified of their own action — _Verify:_ Unit

## R22 — Automations

- [ ] **R22.1** — Automations table (trigger, condition, action, enabled) — _Verify:_ DB
- [ ] **R22.2** — Admin UI `/settings/automations` create/edit/toggle — _Verify:_ UI
- [ ] **R22.3** — Trigger: status changed to X — _Verify:_ Unit
- [ ] **R22.4** — Trigger: job overdue — _Verify:_ Unit
- [ ] **R22.5** — Trigger: revision requested — _Verify:_ Unit
- [ ] **R22.6** — Trigger: job approved — _Verify:_ Unit
- [ ] **R22.7** — Trigger: editor workload reaches threshold — _Verify:_ Unit
- [ ] **R22.8** — Action: notify user/role (photographer, editor, manager) — _Verify:_ Unit
- [ ] **R22.9** — Action: assign to original editor — _Verify:_ Unit
- [ ] **R22.10** — Action: change status (e.g. Approved → Completed) — _Verify:_ Unit via transitionJobStatus
- [ ] **R22.11** — Rule engine runs inside `transitionJobStatus()` side effects — _Verify:_ Code
- [ ] **R22.12** — Automation executions logged as activity events (actor = system/automation) — _Verify:_ DB
- [ ] **R22.13** — Loop protection (automation-triggered transitions don't re-fire infinitely) — _Verify:_ Unit
- [ ] **R22.14** — Automations org-scoped and admin-only — _Verify:_ API as editor → 403
- [ ] **R22.15** — Default seeded rules match spec examples — _Verify:_ DB seed

## R23 — Client / Project structure

- [ ] **R23.1** — Organisation entity — _Verify:_ DB
- [ ] **R23.2** — Client belongs to organisation — _Verify:_ DB FK
- [ ] **R23.3** — Project belongs to client — _Verify:_ DB FK
- [ ] **R23.4** — Job belongs to project (and client) — _Verify:_ DB FK
- [ ] **R23.5** — Clients page `/production/clients` list + create + edit — _Verify:_ UI/API
- [ ] **R23.6** — Client detail shows projects and jobs — _Verify:_ UI
- [ ] **R23.7** — Projects page `/production/projects` list + create + edit — _Verify:_ UI/API
- [ ] **R23.8** — Project detail shows jobs (e.g. Photography, Editing, Twilight…) — _Verify:_ UI
- [ ] **R23.9** — Creating a job from project prefills client — _Verify:_ UI
- [ ] **R23.10** — Client/project mutations audited — _Verify:_ DB
- [ ] **R23.11** — Clients/projects org-scoped — _Verify:_ API cross-org → 404

## R24 — Custom job types

- [ ] **R24.1** — Job types table (name, colour, workflowId, active) — _Verify:_ DB
- [ ] **R24.2** — Admin page `/settings/job-types` CRUD — _Verify:_ UI/API
- [ ] **R24.3** — Seeded types: Real Estate, Wedding, Commercial, Product, Drone, Twilight, Video, Floor Plans, Virtual Staging, Retouching — _Verify:_ DB seed
- [ ] **R24.4** — Job type may reference its own workflow — _Verify:_ DB FK; Unit: job uses type's workflow statuses
- [ ] **R24.5** — Deactivating a type keeps existing jobs intact — _Verify:_ Unit
- [ ] **R24.6** — Job type filter available (R20.12) — _Verify:_ API

## R25 — Dashboard customisation

- [ ] **R25.1** — Widget: my workload — _Verify:_ UI
- [ ] **R25.2** — Widget: team workload — _Verify:_ UI
- [ ] **R25.3** — Widget: due today — _Verify:_ UI
- [ ] **R25.4** — Widget: overdue — _Verify:_ UI
- [ ] **R25.5** — Widget: recent activity — _Verify:_ UI
- [ ] **R25.6** — Widget: editor performance — _Verify:_ UI
- [ ] **R25.7** — Widget: completion rate — _Verify:_ UI
- [ ] **R25.8** — Widget: revision rate — _Verify:_ UI
- [ ] **R25.9** — Widget: bottlenecks — _Verify:_ UI
- [ ] **R25.10** — Widget: calendar (mini) — _Verify:_ UI
- [ ] **R25.11** — Widget: recent completed — _Verify:_ UI
- [ ] **R25.12** — Widgets can be shown/hidden — _Verify:_ UI
- [ ] **R25.13** — Widgets rearrangeable (drag) — _Verify:_ E2E
- [ ] **R25.14** — Layout persisted per user — _Verify:_ DB: `users.dashboardLayout` or `saved_views`

## R26 — Design direction

- [ ] **R26.1** — Design tokens in `src/app/globals.css` (Tailwind v4 @theme) — _Verify:_ Code
- [ ] **R26.2** — Consistent typography scale — _Verify:_ UI review
- [ ] **R26.3** — Consistent spacing / hierarchy — _Verify:_ UI review
- [ ] **R26.4** — Sidebar + topbar navigation layout — _Verify:_ UI
- [ ] **R26.5** — Design-system primitives: Button, Card, Table, Badge, Dialog, Input, Select, Skeleton — _Verify:_ Code: `src/components/ui/*`
- [ ] **R26.6** — Tables with sticky header, hover rows — _Verify:_ UI
- [ ] **R26.7** — Filter bar component reused across lists — _Verify:_ Code
- [ ] **R26.8** — Subtle transitions/animations (no jank) — _Verify:_ UI
- [ ] **R26.9** — Responsive at 375 / 768 / 1280 widths — _Verify:_ E2E viewport tests
- [ ] **R26.10** — Keyboard shortcut: Cmd/Ctrl+K palette — _Verify:_ E2E
- [ ] **R26.11** — Keyboard shortcuts: navigation (g d, g j…) or documented set — _Verify:_ UI help dialog `?`
- [ ] **R26.12** — Empty states on every list — _Verify:_ Code grep `EmptyState`
- [ ] **R26.13** — Loading states (`loading.tsx` / Skeleton) on every list page — _Verify:_ Code
- [ ] **R26.14** — Error boundaries (`error.tsx`) on every route group — _Verify:_ Code
- [ ] **R26.15** — Dark mode or at least no broken contrast (WCAG AA) — _Verify:_ UI/axe
- [ ] **R26.16** — Status/priority colours consistent across table, kanban, calendar — _Verify:_ Code: single colour map

## R27 — Main navigation

- [ ] **R27.1** — Nav: Dashboard — _Verify:_ UI link works
- [ ] **R27.2** — Nav: Workspace → All Work — _Verify:_ UI
- [ ] **R27.3** — Nav: Workspace → My Work — _Verify:_ UI
- [ ] **R27.4** — Nav: Workspace → Team Work — _Verify:_ UI
- [ ] **R27.5** — Nav: Workspace → Kanban — _Verify:_ UI
- [ ] **R27.6** — Nav: Workspace → Calendar — _Verify:_ UI
- [ ] **R27.7** — Nav: Workspace → Timeline — _Verify:_ UI
- [ ] **R27.8** — Nav: Production → Jobs — _Verify:_ UI
- [ ] **R27.9** — Nav: Production → Projects — _Verify:_ UI
- [ ] **R27.10** — Nav: Production → Clients — _Verify:_ UI
- [ ] **R27.11** — Nav: Team → Photographers — _Verify:_ UI
- [ ] **R27.12** — Nav: Team → Editors — _Verify:_ UI
- [ ] **R27.13** — Nav: Team → Workloads — _Verify:_ UI
- [ ] **R27.14** — Nav: Team → Performance — _Verify:_ UI
- [ ] **R27.15** — Nav: Insights → Analytics — _Verify:_ UI
- [ ] **R27.16** — Nav: Insights → Bottlenecks — _Verify:_ UI
- [ ] **R27.17** — Nav: Insights → Reports — _Verify:_ UI
- [ ] **R27.18** — Nav: Activity → Activity Log — _Verify:_ UI
- [ ] **R27.19** — Nav: Settings → Organisation — _Verify:_ UI
- [ ] **R27.20** — Nav: Settings → Users — _Verify:_ UI
- [ ] **R27.21** — Nav: Settings → Roles — _Verify:_ UI
- [ ] **R27.22** — Nav: Settings → Workflows — _Verify:_ UI
- [ ] **R27.23** — Nav: Settings → Job Types — _Verify:_ UI
- [ ] **R27.24** — Nav: Settings → Automations — _Verify:_ UI
- [ ] **R27.25** — Nav: Settings → Notifications — _Verify:_ UI
- [ ] **R27.26** — Nav items filtered by role (editors don't see Settings/Insights) — _Verify:_ UI as editor; Code: nav config `roles`
- [ ] **R27.27** — Active nav item highlighted — _Verify:_ UI
- [ ] **R27.28** — Nav config single source (`src/lib/nav.ts`) — _Verify:_ Code

## R28 — Mobile responsiveness

- [ ] **R28.1** — Sidebar collapses to drawer/hamburger on mobile — _Verify:_ E2E 375px
- [ ] **R28.2** — All Work table scrolls horizontally or collapses to cards on mobile — _Verify:_ E2E
- [ ] **R28.3** — Job detail usable on phone (tabs scroll, actions reachable) — _Verify:_ E2E
- [ ] **R28.4** — Create job form usable on phone — _Verify:_ E2E
- [ ] **R28.5** — Kanban horizontally scrollable on mobile — _Verify:_ E2E
- [ ] **R28.6** — Calendar degrades to agenda/day on mobile — _Verify:_ E2E
- [ ] **R28.7** — Tablet (768) layout correct — _Verify:_ E2E
- [ ] **R28.8** — Touch targets ≥ 40px on primary actions — _Verify:_ UI review

## R29 — Backend architecture

- [ ] **R29.1** — Authentication: login with email + password — _Verify:_ E2E `/login`
- [ ] **R29.2** — Passwords hashed with bcryptjs (never plaintext) — _Verify:_ DB: `users.passwordHash`; Code
- [ ] **R29.3** — Session = signed cookie (jose), httpOnly, sameSite, secure in prod — _Verify:_ Code: `src/server/auth/session.ts`
- [ ] **R29.4** — Logout clears session — _Verify:_ E2E
- [ ] **R29.5** — `src/proxy.ts` protects `(app)` routes and `/api/*` — _Verify:_ Code + E2E unauthenticated → redirect/401
- [ ] **R29.6** — RBAC enforced server-side in `permissions.ts`, not only UI — _Verify:_ Unit + API 403 tests
- [ ] **R29.7** — Database: SQLite via Drizzle, schema in `src/db/schema.ts` — _Verify:_ Code
- [ ] **R29.8** — Migrations / push script works from clean (`npm run db:push`) — _Verify:_ Command
- [ ] **R29.9** — REST API layer under `src/app/api/**` — _Verify:_ Code
- [ ] **R29.10** — API returns consistent error shape `{ error, code, issues? }` — _Verify:_ API tests
- [ ] **R29.11** — Audit logging on every mutation (R06) — _Verify:_ Code review of services
- [ ] **R29.12** — Validation via Zod on every input (body, params, query) — _Verify:_ Code: `src/lib/validation/*` used in every route
- [ ] **R29.13** — Secure data access: no raw client ids trusted without org check — _Verify:_ Code review of queries
- [ ] **R29.14** — Critical actions (status, assign, approve) never frontend-only — _Verify:_ Code: client components call API/actions only
- [ ] **R29.15** — Rate limiting / brute-force protection on login (basic) — _Verify:_ Code/API
- [ ] **R29.16** — No secrets committed; `.env.example` present — _Verify:_ Repo
- [ ] **R29.17** — Route handlers are thin (parse → auth → service → respond) — _Verify:_ Code review
- [ ] **R29.18** — Deactivated users cannot log in — _Verify:_ E2E/API → 401

## R30 — Data model

- [ ] **R30.1** — Table: users — _Verify:_ DB schema
- [ ] **R30.2** — Table: organisations — _Verify:_ DB
- [ ] **R30.3** — Table: teams (+ team_members) — _Verify:_ DB
- [ ] **R30.4** — Table: clients — _Verify:_ DB
- [ ] **R30.5** — Table: projects — _Verify:_ DB
- [ ] **R30.6** — Table: jobs — _Verify:_ DB
- [ ] **R30.7** — Table: job_types — _Verify:_ DB
- [ ] **R30.8** — Table: workflows + statuses — _Verify:_ DB
- [ ] **R30.9** — Table: comments — _Verify:_ DB
- [ ] **R30.10** — Table: revisions — _Verify:_ DB
- [ ] **R30.11** — Table: assignments (history of who/when/role) — _Verify:_ DB
- [ ] **R30.12** — Table: activity_events — _Verify:_ DB
- [ ] **R30.13** — Table: notifications — _Verify:_ DB
- [ ] **R30.14** — Table: work_sessions — _Verify:_ DB
- [ ] **R30.15** — Table: external_links (with history) — _Verify:_ DB
- [ ] **R30.16** — Table: automations — _Verify:_ DB
- [ ] **R30.17** — Table: saved_views — _Verify:_ DB
- [ ] **R30.18** — Foreign keys declared with Drizzle `references()` — _Verify:_ Code
- [ ] **R30.19** — Indexes on organisationId, jobId, statusId, editorId, dueAt, createdAt — _Verify:_ Code: `index()` in schema
- [ ] **R30.20** — No duplicated denormalised fields without justification (e.g. client name on job) — _Verify:_ Code review
- [ ] **R30.21** — All ids nanoid text — _Verify:_ Code
- [ ] **R30.22** — All timestamps ISO-8601 UTC text — _Verify:_ Code + Unit
- [ ] **R30.23** — `docs/ARCHITECTURE.md` documents the data model — _Verify:_ File exists & matches schema

## R31 — Audit log requirement (immutability)

- [ ] **R31.1** — activity_events column: id — _Verify:_ DB
- [ ] **R31.2** — Column: organisationId — _Verify:_ DB
- [ ] **R31.3** — Column: userId (actor) — _Verify:_ DB
- [ ] **R31.4** — Column: jobId (nullable for non-job events) — _Verify:_ DB
- [ ] **R31.5** — Column: eventType — _Verify:_ DB
- [ ] **R31.6** — Column: action (human description) — _Verify:_ DB
- [ ] **R31.7** — Column: previousValue — _Verify:_ DB
- [ ] **R31.8** — Column: newValue — _Verify:_ DB
- [ ] **R31.9** — Column: createdAt timestamp — _Verify:_ DB
- [ ] **R31.10** — Column: metadata JSON — _Verify:_ DB
- [ ] **R31.11** — No UPDATE code path for activity_events — _Verify:_ Code: `grep -rn "update(activityEvents)" src` empty
- [ ] **R31.12** — No DELETE code path for activity_events — _Verify:_ Code: `grep -rn "delete(activityEvents)" src` empty
- [ ] **R31.13** — No API route mutates activity_events — _Verify:_ Code
- [ ] **R31.14** — Non-job events (user, client, settings changes) also logged — _Verify:_ DB
- [ ] **R31.15** — Unit test asserts `src/server/audit.ts` exports only `recordEvent` (append) — _Verify:_ Unit

## R32 — Permissions

- [ ] **R32.1** — Owner: every permission true — _Verify:_ Unit: permissions matrix
- [ ] **R32.2** — Manager: team + production + analytics; not org billing/ownership — _Verify:_ Unit
- [ ] **R32.3** — Manager cannot change owner role or delete org — _Verify:_ API → 403
- [ ] **R32.4** — Photographer: own + assigned jobs — _Verify:_ Unit
- [ ] **R32.5** — Photographer: relevant team visibility (configurable) — _Verify:_ Unit
- [ ] **R32.6** — Editor: assigned jobs only — _Verify:_ Unit
- [ ] **R32.7** — Editor: permitted team info only — _Verify:_ Unit
- [ ] **R32.8** — Editor cannot see performance of other editors — _Verify:_ API `/api/team/performance` as editor → 403
- [ ] **R32.9** — Editor cannot see internal notes — _Verify:_ API
- [ ] **R32.10** — Editor cannot see analytics/bottlenecks/reports — _Verify:_ API → 403
- [ ] **R32.11** — Per-role permission overrides stored (Roles settings page) — _Verify:_ DB: `role_permissions` or org JSON
- [ ] **R32.12** — Permission checks centralised in `src/server/auth/permissions.ts` — _Verify:_ Code: no ad-hoc role string checks in routes
- [ ] **R32.13** — Permission denied returns 403 with no data leakage — _Verify:_ API
- [ ] **R32.14** — Hidden resources return 404 (not 403) when not in org — _Verify:_ API

## R33 — Principle

- [ ] **R33.1** — "Who is doing what" answerable from dashboard/All Work in one screen — _Verify:_ UI walkthrough
- [ ] **R33.2** — "When will it be finished" (due date + days remaining) visible per job — _Verify:_ UI
- [ ] **R33.3** — "What has happened" (history) one click from any job — _Verify:_ UI
- [ ] **R33.4** — "What needs attention" (overdue, review, revision, bottlenecks) on dashboard — _Verify:_ UI

## R34 — Traceability

- [ ] **R34.1** — Who worked on it (all assignees ever) — _Verify:_ UI job detail Assignments
- [ ] **R34.2** — When they started — _Verify:_ UI history `work_started`
- [ ] **R34.3** — What they did (notes, links, comments, sessions) — _Verify:_ UI tabs
- [ ] **R34.4** — When submitted — _Verify:_ UI
- [ ] **R34.5** — Who reviewed — _Verify:_ UI (approver / revision requester)
- [ ] **R34.6** — What revisions were requested — _Verify:_ UI Revisions tab
- [ ] **R34.7** — How many revisions — _Verify:_ UI count
- [ ] **R34.8** — When approved — _Verify:_ UI
- [ ] **R34.9** — Who approved — _Verify:_ UI
- [ ] **R34.10** — When completed — _Verify:_ UI
- [ ] **R34.11** — Where finished work is — _Verify:_ UI Finished Work
- [ ] **R34.12** — All of the above on ONE job detail page (no screen hunting) — _Verify:_ UI: job summary panel

## R35 — Finished work links

- [ ] **R35.1** — Prominent "Finished Work" section on completed/approved jobs — _Verify:_ UI top of job detail
- [ ] **R35.2** — Supports gallery / Dropbox / Drive / Frame.io / client delivery kinds — _Verify:_ DB `external_links.kind`
- [ ] **R35.3** — Shows Added by — _Verify:_ UI
- [ ] **R35.4** — Shows Date added — _Verify:_ UI
- [ ] **R35.5** — Shows Link (clickable, new tab, rel=noopener) — _Verify:_ UI
- [ ] **R35.6** — Changing a link keeps old link (versioned / `replacedById` or audit) — _Verify:_ DB: old row retained or event with previousValue
- [ ] **R35.7** — Link history viewable — _Verify:_ UI Links tab history
- [ ] **R35.8** — Link kind/label editable with audit — _Verify:_ API PATCH + event
- [ ] **R35.9** — Link removal is soft (kept in history) — _Verify:_ DB: `removedAt`; no hard delete

## R36 — Reporting

- [ ] **R36.1** — Reports page `/insights/reports` — _Verify:_ UI
- [ ] **R36.2** — Production report: completed — _Verify:_ UI + Unit
- [ ] **R36.3** — Production report: outstanding — _Verify:_ UI + Unit
- [ ] **R36.4** — Production report: overdue — _Verify:_ UI + Unit
- [ ] **R36.5** — Production report: average turnaround — _Verify:_ UI + Unit
- [ ] **R36.6** — Editor report: completed, turnaround, revision rate, on-time % — _Verify:_ UI + Unit
- [ ] **R36.7** — Photographer report: submitted (jobs created), completed, processing time — _Verify:_ UI + Unit
- [ ] **R36.8** — Business report: volume — _Verify:_ UI
- [ ] **R36.9** — Business report: bottlenecks — _Verify:_ UI
- [ ] **R36.10** — Business report: capacity — _Verify:_ UI
- [ ] **R36.11** — Business report: trends (chart over time) — _Verify:_ UI recharts
- [ ] **R36.12** — Range: today — _Verify:_ UI/API `?range=today`
- [ ] **R36.13** — Range: this week — _Verify:_ UI/API
- [ ] **R36.14** — Range: this month — _Verify:_ UI/API
- [ ] **R36.15** — Range: last month — _Verify:_ UI/API
- [ ] **R36.16** — Range: custom from/to — _Verify:_ UI/API
- [ ] **R36.17** — Ranges computed in org timezone — _Verify:_ Unit
- [ ] **R36.18** — Reports API `/api/reports?type=&range=` — _Verify:_ API
- [ ] **R36.19** — Export CSV (nice-to-have) — _Verify:_ UI/API

## R37 — Activity feed

- [ ] **R37.1** — Global activity log page `/activity` — _Verify:_ UI
- [ ] **R37.2** — Human sentences ("John completed '123 Smith Street'") — _Verify:_ UI + Unit formatter
- [ ] **R37.3** — Filter by user — _Verify:_ UI/API `?userId=`
- [ ] **R37.4** — Filter by job — _Verify:_ UI/API `?jobId=`
- [ ] **R37.5** — Filter by event type — _Verify:_ UI/API `?eventType=`
- [ ] **R37.6** — Filter by date range — _Verify:_ UI/API
- [ ] **R37.7** — Paginated / infinite scroll — _Verify:_ UI/API
- [ ] **R37.8** — Feed respects role visibility (editor sees only own jobs' events) — _Verify:_ API as editor
- [ ] **R37.9** — Each row links to job — _Verify:_ UI

## R38 — UX (progressive disclosure)

- [ ] **R38.1** — Main row compact: name · assignee · status · due — _Verify:_ UI
- [ ] **R38.2** — Click row → job detail — _Verify:_ UI
- [ ] **R38.3** — Detail tab: Activity — _Verify:_ UI
- [ ] **R38.4** — Detail tab: Comments — _Verify:_ UI
- [ ] **R38.5** — Detail tab: Revisions — _Verify:_ UI
- [ ] **R38.6** — Detail tab: Links — _Verify:_ UI
- [ ] **R38.7** — Detail tab: Timeline (stage durations) — _Verify:_ UI
- [ ] **R38.8** — Detail tab: History — _Verify:_ UI
- [ ] **R38.9** — Tab state in URL (`?tab=`) deep-linkable — _Verify:_ UI
- [ ] **R38.10** — Primary action button contextual to status + role — _Verify:_ UI

## R39 — Demo data

- [ ] **R39.1** — Seed script `npm run db:seed` idempotent / reset via `db:reset` — _Verify:_ Command
- [ ] **R39.2** — ≥ 1 organisation with timezone Australia/Sydney — _Verify:_ DB count
- [ ] **R39.3** — Owner `owner@studio.test` / `Password123!` — _Verify:_ E2E login
- [ ] **R39.4** — ≥ 1 manager demo user — _Verify:_ DB
- [ ] **R39.5** — ≥ 10 photographers — _Verify:_ DB `SELECT count(*) WHERE role='photographer'`
- [ ] **R39.6** — ≥ 10 editors — _Verify:_ DB
- [ ] **R39.7** — ≥ 30 clients — _Verify:_ DB
- [ ] **R39.8** — ≥ 50 projects — _Verify:_ DB
- [ ] **R39.9** — ≥ 150 jobs — _Verify:_ DB
- [ ] **R39.10** — Jobs spread across all statuses — _Verify:_ DB group by status, none zero
- [ ] **R39.11** — Includes completed jobs — _Verify:_ DB
- [ ] **R39.12** — Includes overdue jobs — _Verify:_ DB
- [ ] **R39.13** — Includes revision-required jobs with revision rows — _Verify:_ DB
- [ ] **R39.14** — Includes awaiting-review jobs — _Verify:_ DB
- [ ] **R39.15** — Seeded jobs have realistic activity history (events per status) — _Verify:_ DB events count > jobs
- [ ] **R39.16** — Seeded comments, links, notifications, work sessions — _Verify:_ DB
- [ ] **R39.17** — Seeded automations and saved views — _Verify:_ DB
- [ ] **R39.18** — Demo credentials documented in `src/db/seed.ts` / README — _Verify:_ File

## R40 — Final quality requirement (tests + edge cases)

- [ ] **R40.1** — Test: auth (login, logout, protected routes) — _Verify:_ E2E `e2e/auth.spec.ts`
- [ ] **R40.2** — Test: permissions matrix — _Verify:_ Unit `permissions.test.ts`
- [ ] **R40.3** — Test: job creation — _Verify:_ Unit/API
- [ ] **R40.4** — Test: assignment — _Verify:_ Unit
- [ ] **R40.5** — Test: status changes — _Verify:_ Unit `workflow.test.ts`
- [ ] **R40.6** — Test: comments — _Verify:_ Unit
- [ ] **R40.7** — Test: revisions — _Verify:_ Unit
- [ ] **R40.8** — Test: links — _Verify:_ Unit
- [ ] **R40.9** — Test: notifications — _Verify:_ Unit
- [ ] **R40.10** — Test: activity history / audit trail — _Verify:_ Unit
- [ ] **R40.11** — Test: workloads — _Verify:_ Unit
- [ ] **R40.12** — Test: analytics — _Verify:_ Unit
- [ ] **R40.13** — Test: filters — _Verify:_ Unit/API
- [ ] **R40.14** — Test: search — _Verify:_ Unit/API
- [ ] **R40.15** — Test: kanban drag — _Verify:_ E2E
- [ ] **R40.16** — Test: calendar — _Verify:_ E2E
- [ ] **R40.17** — Test: mobile viewport — _Verify:_ E2E
- [ ] **R40.18** — Edge: editor reassigned mid-edit (old sessions closed, history kept, both notified) — _Verify:_ Unit
- [ ] **R40.19** — Edge: deadline changed (event + notification; overdue recalculated) — _Verify:_ Unit
- [ ] **R40.20** — Edge: job reopened after completion (completedAt handling, event, status) — _Verify:_ Unit
- [ ] **R40.21** — Edge: multiple revisions (#1 #2 #3 preserved, count correct) — _Verify:_ Unit
- [ ] **R40.22** — Edge: editor unavailable/deactivated with active jobs (jobs flagged, reassign flow) — _Verify:_ Unit
- [ ] **R40.23** — Edge: job becomes overdue (KPI/filter/notification update) — _Verify:_ Unit
- [ ] **R40.24** — Edge: two users editing same job (optimistic concurrency / `updatedAt` check or last-write audit) — _Verify:_ Unit
- [ ] **R40.25** — Edge: user loses permission mid-session (next request 403) — _Verify:_ API
- [ ] **R40.26** — Edge: link changed (old link retained) — _Verify:_ Unit
- [ ] **R40.27** — Edge: user deactivated (login blocked, history retains name) — _Verify:_ Unit/E2E
- [ ] **R40.28** — Historical records intact after every edge case (event count never decreases) — _Verify:_ Unit assertion
- [ ] **R40.29** — `npm run test` green — _Verify:_ Command
- [ ] **R40.30** — `npm run e2e` green — _Verify:_ Command

## R41 — Success criteria

- [ ] **R41.1** — WHAT is being worked on — immediately visible — _Verify:_ UI dashboard/All Work
- [ ] **R41.2** — WHO is working on it — _Verify:_ UI
- [ ] **R41.3** — WHEN it is due — _Verify:_ UI
- [ ] **R41.4** — WHERE it is in the workflow — _Verify:_ UI
- [ ] **R41.5** — WHAT has happened — _Verify:_ UI history
- [ ] **R41.6** — WHAT needs attention — _Verify:_ UI dashboard alerts
- [ ] **R41.7** — WHO is overloaded — _Verify:_ UI workloads capacity badges
- [ ] **R41.8** — WHO is performing well — _Verify:_ UI performance
- [ ] **R41.9** — WHETHER completed on time — _Verify:_ UI on-time % + per-job indicator
- [ ] **R41.10** — COMPLETE history available — _Verify:_ UI + DB
- [ ] **R41.11** — Scalability: indexed queries, pagination, no N+1 on lists — _Verify:_ Code review
- [ ] **R41.12** — Reliability: transactions, error boundaries, graceful API errors — _Verify:_ Code review
- [ ] **R41.13** — Security: auth, RBAC, org scoping, hashed passwords, validated input — _Verify:_ Code review + tests
- [ ] **R41.14** — Maintainability: services/queries split, typed, linted, documented — _Verify:_ `npm run typecheck && npm run lint`
- [ ] **R41.15** — Full UX audit completed before completion — _Verify:_ Audit report
- [ ] **R41.16** — Full functionality audit completed — _Verify:_ Audit report
- [ ] **R41.17** — Full database audit completed — _Verify:_ Audit report
- [ ] **R41.18** — Full permissions audit completed — _Verify:_ Audit report
- [ ] **R41.19** — Full workflow audit completed — _Verify:_ Audit report

## R42 — CLAUDE.md non-negotiable architecture rules

- [ ] **R42.1** — Stack unchanged: Next 16.4, React 19, TS strict, Tailwind v4, Drizzle+better-sqlite3, Zod 4, jose, bcryptjs — _Verify:_ `package.json`
- [ ] **R42.2** — `params`/`searchParams`/`cookies()`/`headers()` always awaited — _Verify:_ Code grep
- [ ] **R42.3** — `src/proxy.ts` used (no `middleware.ts`) — _Verify:_ File check
- [ ] **R42.4** — No `"use cache"` anywhere — _Verify:_ Code grep
- [ ] **R42.5** — `"use client"` only on interactive leaves — _Verify:_ Code review
- [ ] **R42.6** — All mutations go through `src/server/services/*` — _Verify:_ Code review of routes/actions
- [ ] **R42.7** — Every service mutation: permission check — _Verify:_ Code
- [ ] **R42.8** — Every service mutation: Zod validation from `src/lib/validation/*` — _Verify:_ Code
- [ ] **R42.9** — Every service mutation: DB transaction — _Verify:_ Code
- [ ] **R42.10** — Every service mutation: audit event in same transaction with before/after — _Verify:_ Code
- [ ] **R42.11** — Org scoping on every query — _Verify:_ Code review
- [ ] **R42.12** — Components never import `src/db` directly — _Verify:_ Code grep `from "@/db"` in `src/components` + `src/app` (pages) empty
- [ ] **R42.13** — Dates helpers in `src/lib/dates.ts`, org tz default Australia/Sydney — _Verify:_ Code + Unit
- [ ] **R42.14** — No `any`, no leftover `console.log` — _Verify:_ `npm run lint` + grep
- [ ] **R42.15** — Tests: vitest `src/**/*.test.ts` + Playwright `e2e/` configured — _Verify:_ Files + commands
- [ ] **R42.16** — `docs/ARCHITECTURE.md` written and current — _Verify:_ File

---

### Item count
R00: 5 · R01: 18 · R02: 48 · R03: 22 · R04: 38 · R05: 18 · R06: 24 · R07: 23 · R08: 24 · R09: 9 · R10: 14 · R11: 5 · R12: 12 · R13: 12 · R14: 8 · R15: 11 · R16: 10 · R17: 14 · R18: 5 · R19: 12 · R20: 18 · R21: 18 · R22: 15 · R23: 11 · R24: 6 · R25: 14 · R26: 16 · R27: 28 · R28: 8 · R29: 18 · R30: 23 · R31: 15 · R32: 14 · R33: 4 · R34: 12 · R35: 9 · R36: 19 · R37: 9 · R38: 10 · R39: 18 · R40: 30 · R41: 19 · R42: 16

**Total: 682 items** (R00–R40 spec sections = 647; R41 success criteria = 19; R42 CLAUDE.md rules = 16).