# REST API contract (`src/app/api/**`)

The contract page agents code against. Every staff route is a thin handler: `requireContext()` (staff only — a client session gets **403** "This area is for studio staff") → one service (mutations) or query (reads) → `{ data }`. **Permissions and validation live in the services/queries** (ARCHITECTURE.md §3, §9); handlers never check either. Shared factories: `src/app/api/_lib/route.ts` (`read`, `readBy`, `mutate`, `mutateById`).

Call it from client islands with `api` from `src/lib/api-client.ts` (`api.get/post/patch/put/delete`), then `router.refresh()`.

**The simplified product (docs/SIMPLIFICATION-PLAN.md) codes against the [Simplified UI](#simplified-ui-docssimplification-planmd) section below.** Everything marked **⚙ Advanced** is hidden behind Settings → Studio → Advanced tools: while the studio's switch is off those routes answer **404** `not_found` ("… is an Advanced tool; turn on Advanced tools in Settings → Studio"), exactly like the hidden pages. The gate (`src/app/api/_lib/advanced.ts`) runs inside the route factories right after `requireContext()`, keyed on the request path (`ADVANCED_FEATURE_META[*].apiPrefixes` + `ADVANCED_JOB_SUBPATHS`); services used internally are never gated.

## Conventions

| Topic | Rule |
|---|---|
| Envelope | Success `{ data: T }` (200). Failure `{ error: { code, message, details?, current? } }`. `api` unwraps `data` and throws `ApiError` on failure. |
| Error codes | `validation` 400 (`details.fieldErrors` = `ApiError.fieldErrors`) · `unauthorized` 401 (api-client redirects to `/login?expired=1`) · `forbidden` 403 · `not_found` 404 (also any unknown `/api` path, including bare `/api`) · `method_not_allowed` 405 (a method the route does not implement; `Allow` header lists the supported ones) · `conflict` 409 (`current` = the row now; show ConflictDialog) · `invalid_transition` / `ambiguous_target` (`details.candidates`) / `editor_required` 422 · `rate_limited` 429 · `internal` 500 (`requestId`). |
| 404 vs 403 | Ids outside your organisation, and jobs you cannot see, are **404**. Collaboration routes (comments/notes/links/timer/sessions) return **403** for an in-org job you may not act on. |
| CSRF | Every non-GET request must send an `Origin` matching the host (browser `fetch` does). Missing/foreign Origin → 403. |
| `expectedVersion` | Required on job field/status mutations (the job's `version`); optional on admin rows and assignments (checked only when sent). Always send it. A stale value → 409. |
| Path ids win | `/api/x/:id` puts the id into the service input (`jobId`, `noteId`, …) **after** the body, so a body cannot retarget another row. |
| Query strings | Repeated keys or `key[]` become arrays (`?statusCategory=review&statusCategory=revision`). Booleans: `1/true/yes`. Lists: `?cursor&limit` (≤ 200) → `Paginated<T> = { items, nextCursor, total? }`. |
| Dates | Deadlines accept a civil date `YYYY-MM-DD` (stored as end of that day in the org timezone) or an ISO instant; `null` clears. Responses are ISO UTC strings — format with `src/lib/dates.ts` and `ctx.settings.timezone`. |
| Automations | Every mutation runs in one transaction and then executes pending automation runs (`withTxThenAutomations`), so rule side effects are visible on the next read. |
| Advanced tools | Routes marked **⚙ Advanced** are 404 while `organisation_settings.advanced_tools_enabled` is off (read it with `GET /api/settings/advanced`). The 404 comes before the feature's own 403, so a hidden feature is indistinguishable from a missing route. |
| Ranges | Analytics/reports take `?range=<RANGE_PRESETS>` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`. |

Who (roles v2; `docs/ROLES.md` §3.3 is authoritative): **A** admin (Owner / Photographer) · **M** photographer team member (⚑ = needs that permission switch: ⚑create, ⚑assign, ⚑review, ⚑workloads, ⚑analytics, ⚑all) · **E** editor (⚑teamJobs) · **C** client (portal routes only). "managed" = the member is the job's photographer or created it as a photographer; "controls" = created it, or managed ∧ ⚑review; "assigned" = current editor (past editors are read-only); "draft" = an editor's own unstarted job (ROLES.md §4.3); "staff" = A, M, E.

---

## Auth (existing)

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password, next? }` | `{ user, redirectTo }` + cookie (`redirectTo` = `/portal` for clients, else `next` or `/dashboard`). Wrong password, inactive account and a client whose portal is off all get the same 401 | public (rate-limited) |
| POST | `/api/auth/logout` | — | `{ ok }` (HTML form → 303 `/login`) | any |
| GET | `/api/auth/me` | — | staff: `{ kind: "staff", user (+ persona, personaLabel, isAdmin, isPrimaryOwner, 7 effective switches), organisation, settings, unreadCount }` · client: `{ kind: "client", name, email, clientName, studioName, unreadCount }` only | signed in (`requireAnyContext`) |
| POST | `/api/auth/change-password` | `{ current, next }` | ok; other sessions revoked | self |

## Jobs

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs` | `scope=mine\|business` (scope-switch holders only; ignored for others), `q, quick, statusCategory[], statusId[], editorId[], photographerId[], clientId[], projectId[], jobTypeId[], priority[], dueFrom, dueTo, sort, groupBy, viewId, cursor, limit` | `JobListResult` (`rows: JobRow[]`, …) | all, row-scoped |
| POST | `/api/jobs` | `CreateJobInput` (strict) `{ name, projectId \| (clientId + newProject: { name, address? }), jobTypeId, clientId?, description?, priority?, photographerId?, editorId?, shootDate?, dueDate?, reviewDueDate?, deliveryDueDate?, estimatedHours? }` | `CreateJobResult` (`{ job, … }`) | A (any photographer); M ⚑create (photographer = self); E ⚑create (photographer required, default photographer; editor = self or none) |
| GET | `/api/jobs/:id` | — | `JobDetail` (incl. `actions: JobAvailableActions`) | job.view |
| PATCH | `/api/jobs/:id` | `{ expectedVersion, name?, description?, clientId?, projectId?, jobTypeId?, shootDate?, estimatedHours?, priority?, dueDate?, reviewDueDate?, deliveryDueDate?, completionPercent? }` | `UpdateJobResult` | per field (edit_fields / set_* / edit_completion_percent) |
| GET | `/api/jobs/by-number/:jobNumber` | e.g. `PJ-0142` | `JobRow` | job.view (404 otherwise) |
| GET | `/api/jobs/:id/transitions` | — | `{ transitions[], allowedColumns: KanbanColumn[], actions: JobAvailableActions }` | job.view |
| POST | `/api/jobs/:id/transition` | `{ toStatusId \| toCategory, expectedVersion, reason?, override?, revision?, startTimer? }` (+ `delivery?: { shareJob?, shareLinkIds? }` on a delivering move only, else 422) | `TransitionResult { job, fromStatus, toStatus, warnings[], revisionId, delivery?, … }` | per edge (ROLES.md §5.2: edge roles, then every action of `actionsForMove`); override A + reason |
| POST | `/api/jobs/:id/accept` | `{ expectedVersion, toStatusId? }` | `TransitionResult` | assigned E; A on behalf |
| POST | `/api/jobs/:id/decline` | `{ expectedVersion, reason? }` | `TransitionResult` | assigned E |
| POST | `/api/jobs/:id/start` | `{ expectedVersion, startTimer?, toStatusId? }` | `TransitionResult` | assigned E; A on behalf |
| POST | `/api/jobs/:id/submit` | `{ expectedVersion }` (in_progress → submitted; a revision is resubmitted via `/api/revisions/:id/resolve`) | `TransitionResult` (+ `warnings` when no finished-work link) | assigned E; A on behalf |
| POST | `/api/jobs/:id/begin-review` | `{ expectedVersion }` | `TransitionResult` | A; M managed ∧ ⚑review (never on a job they edited) |
| POST | `/api/jobs/:id/approve` | `{ expectedVersion }` | `TransitionResult` | A; M managed ∧ ⚑review (never on a job they edited) |
| POST | `/api/jobs/:id/deliver` | `{ expectedVersion }` | `TransitionResult` | A; M managed ∧ ⚑review (never on a job they edited) |
| POST | `/api/jobs/:id/complete` | `{ expectedVersion }` | `TransitionResult` | A; M managed ∧ ⚑review (never on a job they edited) |
| POST | `/api/jobs/:id/cancel` | `{ expectedVersion, reason }` | `TransitionResult` | A; M controls (created it, or managed ∧ ⚑review), not completed |
| POST | `/api/jobs/:id/reopen` | `{ expectedVersion, reason, toCategory?: in_progress\|revision\|approved, revision? }` | `TransitionResult` (422 `editor_required` when no active editor) | A; M managed ∧ ⚑review |
| POST | `/api/jobs/:id/restore` | `{ expectedVersion, reason? }` | `TransitionResult` | A; M controls |
| POST | `/api/jobs/:id/pause` ⚙ Advanced | `{ expectedVersion, reason? }` | `PauseResult` | assigned E in EDITOR_WORKING; A on behalf |
| POST | `/api/jobs/:id/resume` ⚙ Advanced | `{ expectedVersion }` | `PauseResult` | same |
| POST | `/api/jobs/:id/assign` | `{ role: "editor"\|"photographer", userId \| null, reason?, expectedVersion? }` | `AssignEditorResult \| AssignPhotographerResult` (`{ job, changed, … }`) | editor: A, M managed ∧ ⚑assign · photographer: A; E in its draft window |
| POST | `/api/jobs/:id/migrate-workflow` ⚙ Advanced | `{ workflowId, toStatusId, expectedVersion, reason? }` | `{ job, transitionId, eventId }` | A |
| POST | `/api/jobs/:id/recompute` | — | `RecomputeResult { job, changes[] }` | A (system.integrity) |
| GET | `/api/jobs/:id/history` | — | `HistoryEntry[]` (stages + events, oldest first) | job.view_history |
| GET | `/api/jobs/:id/activity` | `cursor, limit, eventType[]` | `Paginated<ActivityFeedItem>` | job.view |
| GET | `/api/jobs/:id/timeline` | — | `TimelineRow` | job.view |
| POST | `/api/jobs/bulk/reassign` ⚙ Advanced | `{ jobIds[≤200], userId \| null, reason? }` | `BulkResult { ok[], failed[{id,code,message}], batchId }` (200 even with failures) | A |
| POST | `/api/jobs/bulk/priority` ⚙ Advanced | `{ jobIds[], priority }` | `BulkResult` | per job set_priority |
| POST | `/api/jobs/bulk/transition` ⚙ Advanced | `{ jobIds[], toStatusId \| toCategory, reason?, override? }` | `BulkResult` | per job edge |

## Revisions

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs/:id/revisions` | — | `{ revisions: RevisionView[], openRevision: RevisionView \| null }` | job.view |
| POST | `/api/jobs/:id/revisions` | `{ expectedVersion, reason, description, instructions?, priority?, dueDate?, assigneeUserId?, toStatusId? }` (= transition → revision) | `RevisionTransitionResult` (`{ revision, job, … }`) | A; M managed ∧ ⚑review |
| PATCH | `/api/revisions/:id` | `{ assigneeUserId?, instructions?, priority?, dueDate? }` (open revisions only) | `UpdateRevisionResult` | A; M managed ∧ ⚑review |
| POST | `/api/revisions/:id/resolve` | `{ expectedVersion (JOB version), note?, toStatusId? }` (→ resubmitted) | `RevisionTransitionResult` | assigned E; A on behalf |
| POST | `/api/revisions/:id/withdraw` | `{ expectedVersion (JOB version), reason? }` | `RevisionTransitionResult` | A; M managed ∧ ⚑review |

## Comments · Notes · Links

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs/:id/comments` | — | `CommentNode[]` (threads) | job.view |
| POST | `/api/jobs/:id/comments` | `{ body, kind?: comment\|question\|clarification_request\|revision_response\|client_feedback, parentCommentId?, revisionId?, mentionUserIds[] }` | `AddCommentResult` | staff on visible jobs (E: assigned or draft). Mentions of people who cannot view the job → **422** naming them. `client_feedback` = a reply inside a client thread only (`client_feedback.reply`: A; M managed ∧ ⚑review); starting a client thread or @mentioning in one → **422** |
| PATCH | `/api/comments/:id` | `{ body }` | `JobComment` | author, within the edit window |
| DELETE | `/api/comments/:id` | — | `JobComment` (soft-deleted) | author; A |
| GET | `/api/jobs/:id/notes` | `?includeArchived=1` | `NoteView[]` | note.read (internal: A, M on managed jobs; editors never internal/client notes) |
| POST | `/api/jobs/:id/notes` | `{ kind: photographer\|editor\|internal\|revision\|client\|delivery, body, revisionId?, isPinned? }` | `JobNote` | A all kinds; M managed (photographer/client/revision; `delivery` needs ⚑review); E assigned or draft (editor/revision) |
| PATCH | `/api/notes/:id` | `{ expectedVersion, body?, isPinned? }` (at least one) | `JobNote` | note.edit |
| POST | `/api/notes/:id/archive` · `/restore` | `{ expectedVersion? }` | `JobNote` | note.archive |
| GET | `/api/notes/:id/history` | — | `NoteHistoryEntry[]` | note.read |
| GET | `/api/jobs/:id/links` | `?history=1` (include replaced/removed) | `LinkSlot[]` | job.view |
| POST | `/api/jobs/:id/links` | `{ kind: LINK_KINDS, url (http/https), label? }` | `JobLink` | A; M managed (client-facing kinds once in review need ⚑review); E working (`EDITOR_LINK_KINDS`) or draft (+ `raw_files`) |
| POST | `/api/links/:id/replace` | `{ url, label? }` (omit label = keep) | `{ link, previous }` | A; M managed; E who added it, while working or in draft, unshared links only |
| POST | `/api/links/:id/remove` | `{ reason? }` | `JobLink` | same |

## Time tracking (⚙ Advanced except `/api/me/work`)

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| POST | `/api/jobs/:id/timer` ⚙ | `{ action: "start"\|"pause"\|"stop", note?, switchFromRunning? }` | `TimerActionResult { action, session, alreadyRunning, stopped }`. Starting while running elsewhere without `switchFromRunning` → 409 | timer.use (org tracking on) |
| GET | `/api/jobs/:id/sessions` ⚙ | — | `{ sessions: WorkSessionView[], totals: SessionTotals }` | job.view (others' sessions: timer.view_others) |
| GET | `/api/me/timer` ⚙ | — | `RunningSessionView \| null` | self |
| GET | `/api/me/work` | — | `MyWorkQueue` | self |

## Clients · Projects

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/clients` | `q, includeArchived` | `ClientListItem[]` | client.view (E: clients of visible jobs) |
| POST | `/api/clients` | `CreateClientInput { name, contactName?, email?, phone?, colour?, notes? }` | `Client` | A; M ⚑create |
| GET | `/api/clients/options` | `q` | `ClientOption[] { id, name, colour }` (non-archived) | anyone who can `job.create` (every non-archived client) |
| GET | `/api/clients/:id` | — | `ClientDetail` | client.view |
| PATCH | `/api/clients/:id` | `{ expectedVersion, ...fields }` | `Client` | A; M createdBy self (never portal columns) |
| POST | `/api/clients/:id/archive` · `/restore` | `{ expectedVersion }` | `Client` | A |
| GET | `/api/projects` | `clientId, q, includeArchived` | `ProjectListItem[]` | project.view |
| POST | `/api/projects` | `CreateProjectInput { clientId, name, address?, description?, startDate?, endDate? }` | `Project` | A; M ⚑create (E: only inline from `POST /api/jobs` `newProject`) |
| GET | `/api/projects/options` | `clientId, q` | `ProjectOption[] { id, name, clientId, clientName }` (non-archived) | anyone who can `job.create` |
| GET | `/api/projects/:id` | — | `ProjectDetail` | project.view |
| PATCH | `/api/projects/:id` | `{ expectedVersion, ...fields }` | `Project` | A; M createdBy self (never `sharedWithClient`) |
| POST | `/api/projects/:id/archive` · `/restore` | `{ expectedVersion }` | `Project` | A |

## Users · Teams

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/users` | `role, active (1/0), q` | `(UserProfile \| ReducedUser)[]` — reduced projection (no email; never client users; `role=client` → 400) for M/E | user.view |
| POST | `/api/users` | `InviteUserInput` (strict, by `role`): photographer `{ email, name, title?, capacityHoursPerWeek?, isAdmin?, flags?: {member switches} }` (omitted switches = invite defaults: review off) · editor `{ …, flags?: { canCreateJobs?, canViewTeamJobs? } }` · client `{ email, name, clientId }` (portal must be on, else 422). Email used anywhere → 409 | `{ user, tempPassword }` (show once) | A |
| GET | `/api/users/options` | `role` (one, comma list or repeated), `jobId` (only people who may view that job — @mentions), `includeInactive=1`, `excludeSelf=1`, `q` | `UserOption[] { id, name, role, avatarColour, isActive, workload: { band, active, overdue } \| null }` — workload only for editors and only when the actor may view team workloads | user.view (`jobId` not visible → 404) |
| GET | `/api/users/:id` | — | `UserDetailView` | user.view (reduced for M/E; a client user's id → 404 for non-admins) |
| PATCH | `/api/users/:id` | `{ expectedVersion, name?, title?, avatarColour?, email? }` | `SafeUser` | A (email: `user.change_email`; never the primary owner unless self); self (name/title/avatar) |
| POST | `/api/users/:id/role` | `{ role, expectedVersion }` | `SafeUser` | A (photographer ⇄ editor only; never self; never the primary owner) |
| POST | `/api/users/:id/deactivate` | `{ expectedVersion, reassignTo? \| unassign?, reason? }` | `DeactivateResult` | A (not self, not the primary owner, last-admin guard) |
| POST | `/api/users/:id/reactivate` | `{ expectedVersion }` | `SafeUser` | A |
| POST | `/api/users/:id/reset-password` | — | `{ userId, tempPassword }` (sessions revoked) | A (staff and client users; not the primary owner); self |
| POST | `/api/users/:id/anonymise` | `{ expectedVersion }` | `SafeUser` | A (deactivated target) |
| POST | `/api/users/:id/capacity` | `{ capacityHoursPerWeek \| null, expectedVersion }` | `SafeUser` | A |
| POST | `/api/users/:id/permissions` | `{ canCreateJobs?, canViewAllJobs?, canAssignEditors?, canReviewSubmissions?, canViewTeamWorkloads?, canViewAnalytics?, canViewTeamJobs?, expectedVersion }` (member switches on non-admin photographers, editor switches on editors; admin target → 422) | `SafeUser` | A (`/visibility` was removed) |
| POST | `/api/users/:id/admin` | `{ isAdmin, expectedVersion }` | `SafeUser` | A (active photographer, not self; last-admin / primary-owner guards → 422) |
| POST | `/api/organisation/primary-owner` | `{ userId, expectedVersion (settings version) }` | `PrimaryOwnerResult` | the primary owner only (target: another active admin) |
| POST | `/api/users/:id/usual-capacity` | `{ usualCapacityJobs \| null, expectedVersion }` (editors only; SIMPLIFICATION-PLAN §7 "Usually handles up to N") | `SafeUser` | A |
| POST | `/api/me/simpler-notice/dismiss` | — | `SafeUser` (the one-time "Proofline got simpler" card; idempotent) | self |
| GET | `/api/users/:id/notification-prefs` | — | `NotificationPrefView[]` | self only |
| PUT | `/api/users/:id/notification-prefs` | `{ prefs: { [NotificationType]: boolean } }` | `NotificationPrefView[]` | self only (mandatory types stay on) |
| GET | `/api/teams` ⚙ Advanced (every `/api/teams/**` route) | `includeArchived` | `TeamView[]` | team.view_members |
| POST | `/api/teams` | `{ name, description?, leadUserId?, memberIds? }` | `TeamWithMembers` | A |
| GET | `/api/teams/:id` | — | `TeamDetail` | team.view_members |
| PATCH | `/api/teams/:id` | `{ expectedVersion, name?, description?, leadUserId? }` | `Team` | A |
| POST | `/api/teams/:id/archive` | `{ expectedVersion }` | `Team` | A |
| POST | `/api/teams/:id/members` | `{ userId }` | `TeamMembership` | A |
| POST | `/api/teams/:id/members/:userId/remove` | — | `TeamMembership` | A |

## Workloads · Analytics · Reports (⚙ Advanced — all of them)

| Method | Path | Query | Response | Who |
|---|---|---|---|---|
| GET | `/api/workloads` | — | `WorkloadRow[]` (all editors with workloads.view_team, else own row / empty) | all |
| GET | `/api/workloads/:userId` | — | `WorkloadDetail` (incl. history series) | person-page rule (ROLES.md §3.4): A; self; M ⚑workloads/⚑analytics on editors, ⚑analytics on photographers |
| GET | `/api/analytics/overview` | `range \| from,to` | `AnalyticsOverview` | analytics.view (A; M ⚑analytics) |
| GET | `/api/analytics/editors` | range | `{ range, editors: PerformanceRow[] }` | analytics.view |
| GET | `/api/analytics/editors/:userId` | range | `EditorAnalytics` | person-page rule (performance); the editor themself |
| GET | `/api/analytics/photographers` | range | `{ range, photographers: PhotographerPerformanceRow[] }` | analytics.view |
| GET | `/api/analytics/business` | range | `Report` (kind `business`) | reports.view |
| GET | `/api/analytics/me` | range | `MyAnalytics` | all (analytics.view_self) |
| GET | `/api/performance` | range | `PerformanceReport` | performance.view (A; M ⚑analytics) |
| GET | `/api/bottlenecks` | — | `BottleneckAlert[]` | bottlenecks.view |
| GET | `/api/reports/:kind` | `range \| from,to`, `format=json\|csv` | `Report`; `format=csv` → `text/csv` attachment (`Content-Disposition` filename from `reportFileName`). Unknown kind → 404 | reports.view / export.csv |

Kinds: `production | editors | photographers | business`. The query-string form `GET /api/reports?type=<kind>&range=…[&format=csv]` is equivalent (missing/unknown `type` → 404). Link a CSV download with a plain `<a href="/api/reports/editors?range=last_30_days&format=csv">`.

## Dashboard · Boards

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/dashboard` | — | `DashboardData` | staff (persona variant; `?scope=mine\|business` for scope-switch holders) |
| GET | `/api/dashboard/layout` ⚙ Advanced (+ `PUT`, `/reset`) | — | `DashboardLayoutView` (`version` 0 = role default) | self |
| PUT | `/api/dashboard/layout` | `{ layout: DashboardLayout, expectedVersion? }` | `DashboardLayoutView` | self (dashboard.customise) |
| POST | `/api/dashboard/layout/reset` | — | `DashboardLayoutView` | self |
| GET | `/api/kanban` ⚙ Advanced (+ `/drop`) | job filters (as `/api/jobs`, incl. `scope`), board options | `KanbanBoard` | all, row-scoped |
| POST | `/api/kanban/drop` | `{ jobId, column: KanbanColumn, expectedVersion, toStatusId?, reason?, revision?, startTimer? }` | `KanbanDropResponse` — see below | per edge |
| GET | `/api/calendar` | `CalendarQuerySchema` (`from, to`, filters) | `CalendarEvent[]` | all, row-scoped |
| GET | `/api/timeline` ⚙ Advanced | `TimelineQuerySchema` (`from, to, groupBy, editorId` = bars held by, `jobId`, plus `q, currentEditorId[], photographerId[], priority[]` applied in SQL before the 500-row cap) | `TimelineRow[]` | row-scoped |
| GET | `/api/team-work` | `TeamWorkQuerySchema` | `TeamWorkGroup[]` | Team Work gate: A; M ⚑all; E ⚑teamJobs (rows visibility-scoped) |

**Kanban drop** (ARCHITECTURE §4.6). Send the drop; act on `data.kind`:

| `kind` | Meaning | UI |
|---|---|---|
| `noop` | Card already in that column | nothing |
| `ambiguous` | `candidates: KanbanMoveOption[]` | popover; re-POST with `toStatusId` |
| `needs_revision_payload` | `move` targets a revision status | open the revision dialog; re-POST with `revision: { reason, description, instructions?, priority?, dueDate?, assigneeUserId? }` |
| `needs_reason` | `move` requires a reason (reopen / cancel) | reason dialog; re-POST with `reason` |
| `moved` | `{ job, fromStatus, toStatus, warnings[] }` | toast (show warnings); refresh |
| *422 `invalid_transition`* | No allowed move into the column; `error.message` explains why ("Assign an active editor first", "Cannot move from …") | snap back + toast |
| *409 `conflict`* | Stale `expectedVersion` | ConflictDialog |

`GET /api/jobs/:id/transitions` returns `allowedColumns` so the board can dim invalid drop targets before the drag ends.

## Activity · Notifications · Search · Saved views

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/activity` | `userId, jobId, eventType[], entityType[], from, to, cursor, limit` | `Paginated<ActivityFeedItem>` | activity.view_global (scoped; management events A only) |
| GET | `/api/notifications` | `unread=1, cursor, limit` | `Paginated<NotificationView>` | self |
| POST | `/api/notifications/:id/read` | — | `{ id, readAt }` (idempotent) | self |
| POST | `/api/notifications/read-all` | — | `{ updated }` | self |
| GET | `/api/search` | `q, limit` | `SearchResults` (grouped) | search.global (scoped) |
| GET | `/api/views` ⚙ Advanced (every `/api/views/**` route) | `scope` | `SavedViewItem[]` (own + shared) | self |
| POST | `/api/views` | `{ name, scope, config: { filters, sort, columns, … }, isShared?, isDefault? }` | `SavedView` | self; `isShared` A |
| GET | `/api/views/:id` | — | `SavedViewItem` | owner of the view, or shared |
| PATCH | `/api/views/:id` | `{ expectedVersion, name?, config?, isShared?, isDefault? }` | `SavedView` | owner of the view |
| DELETE | `/api/views/:id?expectedVersion=N` | (version in the query: `api.delete` sends no body) | `SavedView` (archived) | owner of the view |

## Settings · Workflows · Job types · Automations

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/settings` | — | `SettingsView` | A |
| PATCH | `/api/settings` | `{ expectedVersion, organisationName?, …any settings field }` (incl. `advancedToolsEnabled`, Settings → Studio → Advanced tools) | `UpdateSettingsResult { …, changedFields[] }` (no change → 200, empty list) | A |
| POST | `/api/settings/close-delivered-jobs` | `{ confirm: true }` | `CloseDeliveredJobsResult { ok[], failed[] }` — every Approved / Delivered job completed one by one through the recorded engine move (SIMPLIFICATION-PLAN §9) | A |
| GET | `/api/settings/permissions` ⚙ Advanced | — | `PermissionMatrixRow[]` | A |
| GET | `/api/workflows` ⚙ Advanced (every `/api/workflows/**`, `/api/statuses/**`, `/api/transitions/**` route) | — | `WorkflowListItem[]` | A |
| POST | `/api/workflows` | `{ name, description?, from?: default\|workflow\|blank, sourceWorkflowId?, isDefault? }` | `WorkflowGraph` | A |
| GET | `/api/workflows/:id` | — | `WorkflowGraph` | A |
| PATCH | `/api/workflows/:id` | `{ expectedVersion, name?, description?, isDefault?: true }` | `WorkflowGraph` | A |
| POST | `/api/workflows/:id/archive` | `{ expectedVersion }` | `Workflow` | A |
| POST | `/api/workflows/:id/statuses` | `{ name, category, key?, colour?, description?, sortOrder?, isInitial? }` | `{ status, graph }` | A |
| POST | `/api/workflows/:id/reorder` | `{ statusIds[] }` (every live status, new order) | `WorkflowGraph` | A |
| POST | `/api/workflows/:id/transitions` | `{ fromStatusId, toStatusId, allowedRoles[], label?, requiresAssignedEditor?, assigneeOnly?, isReopen? }` | `{ transition, graph }` | A |
| PATCH | `/api/statuses/:id` | `{ expectedVersion, name?, category?, colour?, description?, isInitial?: true }` | `UpdateStatusResult` | A |
| POST | `/api/statuses/:id/archive` | `{ expectedVersion }` (blocked while jobs sit in it) | `{ status, graph }` | A |
| PATCH | `/api/transitions/:id` | `{ label?, allowedRoles?, requiresAssignedEditor?, assigneeOnly?, isReopen? }` | `{ transition, graph }` | A |
| POST | `/api/transitions/:id/archive` | — | `{ transition, graph }` | A |
| GET | `/api/job-types` | `includeArchived=1` | `JobTypeView[]` | staff (create-job form) |
| POST | `/api/job-types` | `{ name, colour?, workflowId?, defaultEstimatedHours?, sortOrder? }` | `JobType` | A |
| PATCH | `/api/job-types/:id` | `{ expectedVersion, name?, colour?, workflowId?, defaultEstimatedHours?, sortOrder? }` | `JobType` | A |
| POST | `/api/job-types/:id/archive` · `/restore` | `{ expectedVersion }` | `JobType` | A |
| GET | `/api/automations` ⚙ Advanced (every `/api/automations/**` and `/api/automation-runs` route) | `includeArchived=1` | `AutomationListItem[]` | A |
| POST | `/api/automations` | `CreateAutomationInput { name, description?, trigger, conditions?, actions, isEnabled?, sortOrder? }` | `Automation` | A |
| GET | `/api/automations/:id` | — | `AutomationDetail` | A |
| PATCH | `/api/automations/:id` | `{ expectedVersion, …fields }` | `Automation` | A |
| POST | `/api/automations/:id/toggle` | `{ expectedVersion, isEnabled? }` (omitted = flip) | `Automation` | A |
| POST | `/api/automations/:id/archive` | `{ expectedVersion }` | `Automation` | A |
| POST | `/api/automations/:id/dry-run` | `{ jobId, triggerEventId? }` | `AutomationDryRunResult` (no writes) | A |
| GET | `/api/automations/:id/runs` | `status, jobId, cursor, limit` | `Paginated<AutomationRunView>` | A |
| GET | `/api/automation-runs` | `automationId, status, jobId, cursor, limit` | `Paginated<AutomationRunView>` | A |

## Simplified UI (docs/SIMPLIFICATION-PLAN.md)

The five-stage product — **shoot → give to an editor → check → done** — codes against these routes only. Every action is a composite built ON the engine (`src/server/services/simple.ts`): each underlying status is still its own history row, nothing is bulk-updated, and a workflow that lacks a step stops at the furthest step it can reach. Stage words are the plan's: *Needs editor · With editor · Ready to check · Changes asked · Done* (+ Cancelled). All bodies are **strict** (unknown keys → 400). `expectedVersion` is the **job's** version on every job action.

### Reads

| Method | Path | Query | Response | Who |
|---|---|---|---|---|
| GET | `/api/home` | — | `OwnerHome { viewer, topline { toCheck, late, needsEditor }, readyToCheck: ReadyToCheckCard[], needsAttention: NeedsAttentionRow[] (one row per job: `reason` + `also[]`, capped), needsAttentionMore, yourEditors: HomeEditorRow[] \| null (owners only), comingUp: ComingUpItem[], simplerNotice, emptyStudio, asOf }` (plan §6) | photographers (A, M); editors → 403 |
| GET | `/api/my-jobs` | — | `MyJobs { viewer, nextUp: MyJobCard \| null, changesAsked[], late[], toDo[], waitingForCheck[], doneRecently[]: MyJobCard[], thisMonth: MyJobsFooter, asOf }` (plan §6) | editors only; others → 403 |
| GET | `/api/jobs/simple` | `stage=all_active\|needs_editor\|with_editor\|ready_to_check\|changes_asked\|done\|cancelled`, `late=1`, `showCancelled=1`, `q`, `editorId` (`none` = no editor), `clientId`, `cursor`, `limit (≤200)` | `SimpleJobListResult & { counts: StageCounts }` — `rows: SimpleJobRow[]` (stage pill data, waiting on, due chip, round, rush, links), `nextCursor`, `total`, and the tab `counts { allActive, byStage, late, cancelled }` under the same q / editor / client filters | staff, row-scoped (A everything; M own shoots; E jobs given to them) |
| GET | `/api/jobs/simple/calendar` | `from=YYYY-MM-DD&to=YYYY-MM-DD` (≤ 92 days) | `SimpleCalendarEvent[]` (shoot + due dates; List / Calendar switch, editor Calendar page) | staff, row-scoped |
| GET | `/api/jobs/:id/simple` | — | `SimpleJobPage { header, nextStep, files, instructions[], changesAsked[], messages: CommentNode[], privateNotes: NoteView[] \| null (staff only), fromClient: CommentNode[] \| null (portal clients only), whoDidWhat[], sideColumn, permissions, description, asOf }` — the whole single-scroll job page (plan §5) | job.view (404 otherwise) |
| GET | `/api/jobs/:id/simple/approve` | — | `{ shareChoice: "ask" \| "n/a" }` — "ask" when the client uses the portal (show *Approve & send / Approve only*), else finish straight away | job.view |
| GET | `/api/editors` | `period=this_month\|last_month\|last_3_months` | `EditorsOverview { period, waitingOnYou { count, oldestAgeSeconds }, rows: EditorOverviewRow[] (On their desk · Late now · Finished · On time % · Needed changes %; `notEnough` below 5 finished), extraPhotographers[] }` (plan §7) | A; M ⚑analytics; others → 403 |
| GET | `/api/editors/:id` | `period` | `EditorDetail` (five numbers with vs-last-month deltas, on their desk now, recently finished (20), finished per week) — 404 for a non-editor id | same |
| GET | `/api/editors.csv` | `period` | `text/csv` attachment (the table + "Average days to edit"); link it with a plain `<a href>` | same |
| GET | `/api/editors/options` | — | `EditorPickerOption[] { editor: UserRef, onDesk, late, usualCapacity: number \| null, full }` — the Assign / Change editor picker ("On their desk 3 · Late 1") | staff |
| GET | `/api/people` | — | `PeopleOverview { owners[], photographers[], editors[], clients { withPortal, total } }` — Settings → People | A |
| GET | `/api/settings/advanced` | — | `AdvancedState { enabled, forcedOn, forcedReasons[], effective, canManage, columnPresent }` — `forcedOn` when the studio has custom workflows or live automations (the switch is on automatically) | A |

### Job actions — `POST /api/jobs/:id/simple/<action>`

Every action (and the engine's `POST /api/jobs/:id/start` the optional *Start editing* uses) checks `expectedVersion` **before** the actor and stage checks, so a page that is out of date (the job was just moved to someone else) gets `409` — "someone else just changed this job" — never a `403` that contradicts the screen.

Every response is `{ job, stage: StageDisplay, … }` so the caller can repaint the pill without a refetch. A stale `expectedVersion` → 409 (ConflictDialog). An action that is not available in the job's current stage → 422 `invalid_transition` with a plain message (*"Approve" is not available while the job is in With editor*).

| Action | Body | Extra response fields | Who | Stage before → after |
|---|---|---|---|---|
| `assign` | `{ editorId, expectedVersion }` | `assignment: AssignEditorResult` | A; M managed ∧ ⚑assign (`job.assign_editor`) | Needs editor → With editor (skips "Ready"); also re-assigns With editor / Changes asked |
| `change-editor` | `{ editorId, expectedVersion, reason? }` | `assignment` | same | With editor / Ready to check / Changes asked — same stage, new editor |
| `take-back` | `{ expectedVersion, reason? }` | `assignment` | same (422 when the job has no editor) | With editor / Changes asked → Needs editor |
| `decline` | `{ expectedVersion, reason }` (required) | `transition` | the assigned E, before editing starts (`job.decline`); once started → 422 "ask the photographer to take the job back" | With editor → Needs editor ("Can't do this one") |
| `send-for-checking` | `{ expectedVersion, finishedLink: { url, label? } \| { reuseCurrent: true }, note? }` — the finished link is **required** (any http(s) URL, a shared-drive folder included); `reuseCurrent` = "I updated the same link" | `finishedLink: JobLink`, `transitions[]` (Start editing is recorded first when the job had not started), `warnings[]` | assigned E (`job.submit` / `revision.resolve`); A on behalf | With editor / Changes asked → Ready to check |
| `approve` | `{ expectedVersion, share: "send" \| "only" \| "n/a", confirmSelfApproval?, shareLinkIds? }` — `send` = *Approve & send* (Approved → Delivered, sharing the finished / gallery / download links → Completed), `only` = *Approve only* (stops at Approved: "Not sent to client"), `n/a` = the client has no portal (Approved → Completed). `confirmSelfApproval: true` = the owner's "You edited this yourself. Approve anyway?" (decision 3) | `steps[]`, `stoppedAt`, `notSentToClient`, `sharedWithClient`, `selfApproved` | A; M managed ∧ ⚑review. Editors and non-admin photographers never approve their own edit (403); an admin who edited it must confirm | Ready to check → Done |
| `ask-for-changes` | `{ expectedVersion, note (required), chips?: string[] (Sky, Straighten, Colour, Remove items, Crop, Missing photos), neededBy?: YYYY-MM-DD (default tomorrow) }` | `revision: JobRevision`, `transition` | A; M managed ∧ ⚑review (never on a job they edited) | Ready to check → Changes asked (Round N) |
| `reopen` | `{ expectedVersion, reason: "client_changes" \| "fix_delivery_link", note?, newLink?: { url, label? } }` — `fix_delivery_link` requires `newLink` | `transition` (client_changes) or `link` (fix_delivery_link) | A; M managed ∧ ⚑review (`job.reopen` on Completed jobs; 422 `editor_required` when no active editor) | Done → Changes asked, or stays Done with a new client-visible link |
| `cancel` | `{ expectedVersion, reason }` (required) | `transition` | A; M controls | any active stage → Cancelled |
| `restore` | `{ expectedVersion, reason? }` | `transition` | A; M controls | Cancelled → the stage it left |

### Me · Settings · People · Types of shoot

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| POST | `/api/me/mark-old-updates-read` | — | `{ updated }` — your unread notifications of the 18 now-off-by-default types are marked read; nothing is deleted | self |
| POST | `/api/me/simpler-notice/dismiss` (the address the Home card calls) | — | `SafeUser` — hides the one-time "Proofline got simpler" card (idempotent, audited) | self |
| PATCH | `/api/settings/advanced` | `{ enabled, expectedVersion? }` (organisation_settings version) | `SetAdvancedToolsResult { enabled, settings, changed }` | A |
| POST | `/api/settings/close-delivered-jobs` | `{ confirm: true }` | `CloseDeliveredJobsResult { ok[], failed[{ id, code, message }] }` — every Approved / Delivered job is completed one by one through the normal recorded move (200 even with failures) | A |
| POST | `/api/users/:id/usual-capacity` | `{ usualCapacityJobs: number \| null, expectedVersion? }` | `SafeUser` — "Usually handles up to N" (editors only, else 422; null clears) | A |
| POST | `/api/job-types/:id/usual-days` | `{ usualDaysToEdit: number \| null, expectedVersion? }` | `JobType` — pre-fills a new job's due date (shoot date + N) | A |

The existing routes the simple screens still use unchanged: `POST /api/jobs` (New job), `PATCH /api/jobs/:id` (Edit details), `/api/jobs/:id/comments` (Messages), `/api/jobs/:id/notes` (Private notes, kind `internal`), `/api/jobs/:id/links` + `/api/links/:id/*` (Files), `/api/jobs/:id/history` (Full history), `/api/jobs/:id/start` (the optional *Start editing*), `/api/clients/**`, `/api/users/**`, `/api/job-types/**`, `/api/notifications/**`, `/api/search`, `/api/activity` (Settings → History), `/api/settings`.

## Sharing with clients (staff; ROLES.md §7.1–§7.3)

Sharing and portal columns are written only by these routes (and the delivery step of `POST /api/jobs/:id/transition`); every generic schema rejects them with 400.

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| POST | `/api/jobs/:id/share` | `{ shared, expectedVersion }` | `{ job, changed, eventId, notifiedUserIds }` (client users get "Work shared with you") | A; M managed ∧ ⚑review |
| POST | `/api/projects/:id/share` | `{ shared, expectedVersion }` (covers current and future jobs) | `{ project, changed, eventId, jobCount, notifiedUserIds }` | A |
| POST | `/api/links/:id/share` | `{ shared }` (current links only) | `{ link, changed, eventId }` | A; M managed ∧ ⚑review |
| POST | `/api/clients/:id/portal` | `{ portalEnabled?, feedbackEnabled?, expectedVersion }` (portal off signs its users out) | `{ client, changed, eventId }` | A |
| GET | `/api/clients/:id/portal-users` | — | `ClientPortalUser[]` | A |
| POST | `/api/me/scope` | **Removed** with the "My shoots / Whole business" switch (SIMPLIFICATION-PLAN §8): answers 404 for every method after auth. `?scope=` on list routes is ignored for everyone. | 404 | — |

Client users are invited with `POST /api/users { role: "client", clientId, name, email }`; reset / deactivate / reactivate use the normal user routes.

## Client portal (`/api/portal/**`, `requirePortalContext()`; staff sessions get 403)

Every read starts from `portalJobsWhere` (jobs of the user's own client, shared directly or through their project; cancelled ones for 30 days) and returns the whitelisted projection of ROLES.md §7.4 — never editors, statuses, priorities, internal notes or staff comments. Anything outside it is **404**. Bodies are strict (no `kind`, mentions or revision ids).

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/portal/me` | — | `PortalViewer` | C |
| PATCH | `/api/portal/me` | `{ name, expectedVersion? }` | `PortalViewer` | C (self) |
| GET | `/api/portal/jobs` | `sort=progress\|delivered` | `PortalProjectGroup[]` (with `sort`: a flat, sorted `PortalJob[]`) | C |
| GET | `/api/portal/jobs/:id` | — | `PortalJobDetail` (milestone, dates, shared links, delivery notes, feedback threads, `canGiveFeedback`) | C, shared jobs only |
| GET | `/api/portal/projects/:id` | — | `PortalProjectGroup` | C, shared jobs only |
| POST | `/api/portal/jobs/:id/feedback` | `{ body, parentCommentId? }` | the new message | C, `portal.give_feedback` (feedback on and job not cancelled, else 403) |
| PATCH | `/api/portal/comments/:id` | `{ body }` | message | C, own feedback within 15 min |
| DELETE | `/api/portal/comments/:id` | — | message (soft-deleted) | C, own feedback |
| GET | `/api/portal/notifications` | `cursor, limit` | `{ items, nextCursor }` (client types only) | C |
| POST | `/api/portal/notifications/:id/read` · `/read-all` | — | ok | C |
| GET / PUT | `/api/portal/notification-prefs` | `{ prefs: { client_work_shared?, client_work_delivered?, client_feedback_reply? } }` | `NotificationPrefView[]` | C |

## System (existing)

| Method | Path | Response | Who |
|---|---|---|---|
| POST | `/api/system/sweep` | `SweepResult` | A |
| GET | `/api/system/integrity` | `IntegrityReport { ok, drift[], structural[] }` | A |

There are no hard deletes: `DELETE` exists only for the soft comment delete and saved views (archive).

## Client-side pattern

```ts
try {
  const res = await api.post<ApproveJobResult>(`/api/jobs/${job.id}/simple/approve`, { expectedVersion: job.version, share: "n/a" });
  res.steps.flatMap((s) => s.warnings).forEach((w) => toast.warning(w));
  toast.success(res.notSentToClient ? "Approved" : "Approved and sent");
  router.refresh();
} catch (err) {
  if (err instanceof ApiError && err.isConflict) openConflictDialog(err.current);
  else if (err instanceof ApiError && err.code === "validation") setFieldErrors(err.fieldErrors);
  else toast.error(errorMessage(err));
}
```
