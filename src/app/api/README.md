# REST API contract (`src/app/api/**`)

The contract page agents code against. Every route is a thin handler: `requireContext()` → one service (mutations) or query (reads) → `{ data }`. **Permissions and validation live in the services/queries** (ARCHITECTURE.md §3, §9); handlers never check either. Shared factories: `src/app/api/_lib/route.ts` (`read`, `readBy`, `mutate`, `mutateById`).

Call it from client islands with `api` from `src/lib/api-client.ts` (`api.get/post/patch/put/delete`), then `router.refresh()`.

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
| Ranges | Analytics/reports take `?range=<RANGE_PRESETS>` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`. |

Roles: **O** owner · **M** manager · **P** photographer · **E** editor. "own" = photographer or creator of the job; "assigned" = current editor (past editors are read-only).

---

## Auth (existing)

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` | `{ user }` + cookie | public (rate-limited) |
| POST | `/api/auth/logout` | — | `{ ok }` (HTML form → 303 `/login`) | any |
| GET | `/api/auth/me` | — | `{ user, organisation, settings, unreadCount }` | signed in |
| POST | `/api/auth/change-password` | `{ current, next }` | ok; other sessions revoked | self |

## Jobs

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs` | `q, quick, statusCategory[], statusId[], editorId[], photographerId[], clientId[], projectId[], jobTypeId[], priority[], dueFrom, dueTo, sort, groupBy, viewId, cursor, limit` | `JobListResult` (`rows: JobRow[]`, …) | all, row-scoped |
| POST | `/api/jobs` | `CreateJobInput { name, projectId, jobTypeId, clientId?, description?, priority?, photographerId?, editorId?, shootDate?, dueDate?, reviewDueDate?, deliveryDueDate?, estimatedHours? }` | `CreateJobResult` (`{ job, … }`) | O M P (P defaults to self) |
| GET | `/api/jobs/:id` | — | `JobDetail` (incl. `actions: JobAvailableActions`) | job.view |
| PATCH | `/api/jobs/:id` | `{ expectedVersion, name?, description?, clientId?, projectId?, jobTypeId?, shootDate?, estimatedHours?, priority?, dueDate?, reviewDueDate?, deliveryDueDate?, completionPercent? }` | `UpdateJobResult` | per field (edit_fields / set_* / edit_completion_percent) |
| GET | `/api/jobs/by-number/:jobNumber` | e.g. `PJ-0142` | `JobRow` | job.view (404 otherwise) |
| GET | `/api/jobs/:id/transitions` | — | `{ transitions[], allowedColumns: KanbanColumn[], actions: JobAvailableActions }` | job.view |
| POST | `/api/jobs/:id/transition` | `{ toStatusId \| toCategory, expectedVersion, reason?, override?, revision?, startTimer? }` | `TransitionResult { job, fromStatus, toStatus, warnings[], revisionId, … }` | per edge (§4.2); override O M + reason |
| POST | `/api/jobs/:id/accept` | `{ expectedVersion, toStatusId? }` | `TransitionResult` | assigned E; O M on behalf |
| POST | `/api/jobs/:id/decline` | `{ expectedVersion, reason? }` | `TransitionResult` | assigned E |
| POST | `/api/jobs/:id/start` | `{ expectedVersion, startTimer?, toStatusId? }` | `TransitionResult` | assigned E; O M on behalf |
| POST | `/api/jobs/:id/submit` | `{ expectedVersion }` (in_progress → submitted; a revision is resubmitted via `/api/revisions/:id/resolve`) | `TransitionResult` (+ `warnings` when no finished-work link) | assigned E; O M |
| POST | `/api/jobs/:id/begin-review` | `{ expectedVersion }` | `TransitionResult` | O M, own P |
| POST | `/api/jobs/:id/approve` | `{ expectedVersion }` | `TransitionResult` | O M, own P |
| POST | `/api/jobs/:id/deliver` | `{ expectedVersion }` | `TransitionResult` | O M, own P |
| POST | `/api/jobs/:id/complete` | `{ expectedVersion }` | `TransitionResult` | O M, own P |
| POST | `/api/jobs/:id/cancel` | `{ expectedVersion, reason }` | `TransitionResult` | O M, own P (not completed) |
| POST | `/api/jobs/:id/reopen` | `{ expectedVersion, reason, toCategory?: in_progress\|revision\|approved, revision? }` | `TransitionResult` (422 `editor_required` when no active editor) | O M, own P |
| POST | `/api/jobs/:id/restore` | `{ expectedVersion, reason? }` | `TransitionResult` | O M, own P |
| POST | `/api/jobs/:id/pause` | `{ expectedVersion, reason? }` | `PauseResult` | assigned E in EDITOR_WORKING; O M |
| POST | `/api/jobs/:id/resume` | `{ expectedVersion }` | `PauseResult` | same |
| POST | `/api/jobs/:id/assign` | `{ role: "editor"\|"photographer", userId \| null, reason?, expectedVersion? }` | `AssignEditorResult \| AssignPhotographerResult` (`{ job, changed, … }`) | editor: O M, own P · photographer: O M, P createdBy self |
| POST | `/api/jobs/:id/migrate-workflow` | `{ workflowId, toStatusId, expectedVersion, reason? }` | `{ job, transitionId, eventId }` | O M |
| POST | `/api/jobs/:id/recompute` | — | `RecomputeResult { job, changes[] }` | O (system.integrity) |
| GET | `/api/jobs/:id/history` | — | `HistoryEntry[]` (stages + events, oldest first) | job.view_history |
| GET | `/api/jobs/:id/activity` | `cursor, limit, eventType[]` | `Paginated<ActivityFeedItem>` | job.view |
| GET | `/api/jobs/:id/timeline` | — | `TimelineRow` | job.view |
| POST | `/api/jobs/bulk/reassign` | `{ jobIds[≤200], userId \| null, reason? }` | `BulkResult { ok[], failed[{id,code,message}], batchId }` (200 even with failures) | O M |
| POST | `/api/jobs/bulk/priority` | `{ jobIds[], priority }` | `BulkResult` | per job set_priority |
| POST | `/api/jobs/bulk/transition` | `{ jobIds[], toStatusId \| toCategory, reason?, override? }` | `BulkResult` | per job edge |

## Revisions

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs/:id/revisions` | — | `{ revisions: RevisionView[], openRevision: RevisionView \| null }` | job.view |
| POST | `/api/jobs/:id/revisions` | `{ expectedVersion, reason, description, instructions?, priority?, dueDate?, assigneeUserId?, toStatusId? }` (= transition → revision) | `RevisionTransitionResult` (`{ revision, job, … }`) | O M, own P |
| PATCH | `/api/revisions/:id` | `{ assigneeUserId?, instructions?, priority?, dueDate? }` (open revisions only) | `UpdateRevisionResult` | O M, own P |
| POST | `/api/revisions/:id/resolve` | `{ expectedVersion (JOB version), note?, toStatusId? }` (→ resubmitted) | `RevisionTransitionResult` | assigned E; O M on behalf |
| POST | `/api/revisions/:id/withdraw` | `{ expectedVersion (JOB version), reason? }` | `RevisionTransitionResult` | O M, own P |

## Comments · Notes · Links

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/jobs/:id/comments` | — | `CommentNode[]` (threads) | job.view |
| POST | `/api/jobs/:id/comments` | `{ body, kind?: comment\|question\|clarification_request\|revision_response, parentCommentId?, revisionId?, mentionUserIds[] }` | `AddCommentResult` | job.view (E: current editor only). Mentions of people who cannot view the job → **422** naming them |
| PATCH | `/api/comments/:id` | `{ body }` | `JobComment` | author, within the edit window |
| DELETE | `/api/comments/:id` | — | `JobComment` (soft-deleted) | author; O M |
| GET | `/api/jobs/:id/notes` | `?includeArchived=1` | `NoteView[]` | note.read (internal notes: O M, own P) |
| POST | `/api/jobs/:id/notes` | `{ kind: photographer\|editor\|internal\|revision\|client, body, revisionId?, isPinned? }` | `JobNote` | O M; own P (no internal); assigned E (editor/revision) |
| PATCH | `/api/notes/:id` | `{ expectedVersion, body?, isPinned? }` (at least one) | `JobNote` | note.edit |
| POST | `/api/notes/:id/archive` · `/restore` | `{ expectedVersion? }` | `JobNote` | note.archive |
| GET | `/api/notes/:id/history` | — | `NoteHistoryEntry[]` | note.read |
| GET | `/api/jobs/:id/links` | `?history=1` (include replaced/removed) | `LinkSlot[]` | job.view |
| POST | `/api/jobs/:id/links` | `{ kind: LINK_KINDS, url (http/https), label? }` | `JobLink` | O M, own P; assigned E (`EDITOR_LINK_KINDS`) |
| POST | `/api/links/:id/replace` | `{ url, label? }` (omit label = keep) | `{ link, previous }` | O M, own P; E who added it |
| POST | `/api/links/:id/remove` | `{ reason? }` | `JobLink` | same |

## Time tracking

| Method | Path | Body | Response | Who |
|---|---|---|---|---|
| POST | `/api/jobs/:id/timer` | `{ action: "start"\|"pause"\|"stop", note?, switchFromRunning? }` | `TimerActionResult { action, session, alreadyRunning, stopped }`. Starting while running elsewhere without `switchFromRunning` → 409 | timer.use (org tracking on) |
| GET | `/api/jobs/:id/sessions` | — | `{ sessions: WorkSessionView[], totals: SessionTotals }` | job.view (others' sessions: timer.view_others) |
| GET | `/api/me/timer` | — | `RunningSessionView \| null` | self |
| GET | `/api/me/work` | — | `MyWorkQueue` | self |

## Clients · Projects

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/clients` | `q, includeArchived` | `ClientListItem[]` | client.view (E: clients of visible jobs) |
| POST | `/api/clients` | `CreateClientInput { name, contactName?, email?, phone?, colour?, notes? }` | `Client` | O M P |
| GET | `/api/clients/options` | `q` | `ClientOption[] { id, name, colour }` (non-archived) | client.view |
| GET | `/api/clients/:id` | — | `ClientDetail` | client.view |
| PATCH | `/api/clients/:id` | `{ expectedVersion, ...fields }` | `Client` | O M; P createdBy self |
| POST | `/api/clients/:id/archive` · `/restore` | `{ expectedVersion }` | `Client` | O M |
| GET | `/api/projects` | `clientId, q, includeArchived` | `ProjectListItem[]` | project.view |
| POST | `/api/projects` | `CreateProjectInput { clientId, name, address?, description?, startDate?, endDate? }` | `Project` | O M P |
| GET | `/api/projects/options` | `clientId, q` | `ProjectOption[] { id, name, clientId, clientName }` (non-archived) | project.view |
| GET | `/api/projects/:id` | — | `ProjectDetail` | project.view |
| PATCH | `/api/projects/:id` | `{ expectedVersion, ...fields }` | `Project` | O M; P createdBy self |
| POST | `/api/projects/:id/archive` · `/restore` | `{ expectedVersion }` | `Project` | O M |

## Users · Teams

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/users` | `role, active (1/0), q` | `(UserProfile \| UserRef)[]` — reduced `UserRef` for P/E | user.view |
| POST | `/api/users` | `InviteUserInput { email, name, role, title?, avatarColour?, capacityHoursPerWeek?, canViewTeamWorkloads?, canViewAnalytics? }` | `{ user, tempPassword }` (show once) | O; M (P/E targets) |
| GET | `/api/users/options` | `role` (one, comma list or repeated), `jobId` (only people who may view that job — @mentions), `includeInactive=1`, `excludeSelf=1`, `q` | `UserOption[] { id, name, role, avatarColour, isActive, workload: { band, active, overdue } \| null }` — workload only for editors and only when the actor may view team workloads | user.view (`jobId` not visible → 404) |
| GET | `/api/users/:id` | — | `UserDetailView` | user.view (reduced for P/E) |
| PATCH | `/api/users/:id` | `{ expectedVersion, name?, title?, avatarColour?, email? }` | `SafeUser` | O; M (P/E); self (name/title/avatar) |
| POST | `/api/users/:id/role` | `{ role, expectedVersion }` | `SafeUser` | O; M (P ⇄ E only) |
| POST | `/api/users/:id/deactivate` | `{ expectedVersion, reassignTo? \| unassign?, reason? }` | `DeactivateResult` | O; M (P/E) |
| POST | `/api/users/:id/reactivate` | `{ expectedVersion }` | `SafeUser` | O; M (P/E) |
| POST | `/api/users/:id/reset-password` | — | `{ userId, tempPassword }` (sessions revoked) | O; M (P/E); self |
| POST | `/api/users/:id/anonymise` | `{ expectedVersion }` | `SafeUser` | O (deactivated target) |
| POST | `/api/users/:id/capacity` | `{ capacityHoursPerWeek \| null, expectedVersion }` | `SafeUser` | O; M (P/E) |
| POST | `/api/users/:id/visibility` | `{ canViewTeamWorkloads?, canViewAnalytics?, expectedVersion }` | `SafeUser` | O; M (P/E) |
| GET | `/api/users/:id/notification-prefs` | — | `NotificationPrefView[]` | self only |
| PUT | `/api/users/:id/notification-prefs` | `{ prefs: { [NotificationType]: boolean } }` | `NotificationPrefView[]` | self only (mandatory types stay on) |
| GET | `/api/teams` | `includeArchived` | `TeamView[]` | team.view_members |
| POST | `/api/teams` | `{ name, description?, leadUserId?, memberIds? }` | `TeamWithMembers` | O M |
| GET | `/api/teams/:id` | — | `TeamDetail` | team.view_members |
| PATCH | `/api/teams/:id` | `{ expectedVersion, name?, description?, leadUserId? }` | `Team` | O M |
| POST | `/api/teams/:id/archive` | `{ expectedVersion }` | `Team` | O M |
| POST | `/api/teams/:id/members` | `{ userId }` | `TeamMembership` | O M |
| POST | `/api/teams/:id/members/:userId/remove` | — | `TeamMembership` | O M |

## Workloads · Analytics · Reports

| Method | Path | Query | Response | Who |
|---|---|---|---|---|
| GET | `/api/workloads` | — | `WorkloadRow[]` (all editors with workloads.view_team, else own row / empty) | all |
| GET | `/api/workloads/:userId` | — | `WorkloadDetail` (incl. history series) | workloads.view_team; self |
| GET | `/api/analytics/overview` | `range \| from,to` | `AnalyticsOverview` | analytics.view (O M, P with flag) |
| GET | `/api/analytics/editors` | range | `{ range, editors: PerformanceRow[] }` | analytics.view |
| GET | `/api/analytics/editors/:userId` | range | `EditorAnalytics` | analytics.view; the editor themself |
| GET | `/api/analytics/photographers` | range | `{ range, photographers: PhotographerPerformanceRow[] }` | analytics.view |
| GET | `/api/analytics/business` | range | `Report` (kind `business`) | reports.view |
| GET | `/api/analytics/me` | range | `MyAnalytics` | all (analytics.view_self) |
| GET | `/api/performance` | range | `PerformanceReport` | performance.view (O M) |
| GET | `/api/bottlenecks` | — | `BottleneckAlert[]` | bottlenecks.view |
| GET | `/api/reports/:kind` | `range \| from,to`, `format=json\|csv` | `Report`; `format=csv` → `text/csv` attachment (`Content-Disposition` filename from `reportFileName`). Unknown kind → 404 | reports.view / export.csv |

Kinds: `production | editors | photographers | business`. The query-string form `GET /api/reports?type=<kind>&range=…[&format=csv]` is equivalent (missing/unknown `type` → 404). Link a CSV download with a plain `<a href="/api/reports/editors?range=last_30_days&format=csv">`.

## Dashboard · Boards

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/dashboard` | — | `DashboardData` | all (role variant) |
| GET | `/api/dashboard/layout` | — | `DashboardLayoutView` (`version` 0 = role default) | self |
| PUT | `/api/dashboard/layout` | `{ layout: DashboardLayout, expectedVersion? }` | `DashboardLayoutView` | self (dashboard.customise) |
| POST | `/api/dashboard/layout/reset` | — | `DashboardLayoutView` | self |
| GET | `/api/kanban` | job filters (as `/api/jobs`), board options | `KanbanBoard` | all, row-scoped |
| POST | `/api/kanban/drop` | `{ jobId, column: KanbanColumn, expectedVersion, toStatusId?, reason?, revision?, startTimer? }` | `KanbanDropResponse` — see below | per edge |
| GET | `/api/calendar` | `CalendarQuerySchema` (`from, to`, filters) | `CalendarEvent[]` | all, row-scoped |
| GET | `/api/timeline` | `TimelineQuerySchema` (`from, to, groupBy, editorId` = bars held by, `jobId`, plus `q, currentEditorId[], photographerId[], priority[]` applied in SQL before the 500-row cap) | `TimelineRow[]` | row-scoped |
| GET | `/api/team-work` | `TeamWorkQuerySchema` | `TeamWorkGroup[]` | O M; P/E with team-jobs visibility |

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
| GET | `/api/activity` | `userId, jobId, eventType[], entityType[], from, to, cursor, limit` | `Paginated<ActivityFeedItem>` | activity.view_global (scoped; management events O M only) |
| GET | `/api/notifications` | `unread=1, cursor, limit` | `Paginated<NotificationView>` | self |
| POST | `/api/notifications/:id/read` | — | `{ id, readAt }` (idempotent) | self |
| POST | `/api/notifications/read-all` | — | `{ updated }` | self |
| GET | `/api/search` | `q, limit` | `SearchResults` (grouped) | search.global (scoped) |
| GET | `/api/views` | `scope` | `SavedViewItem[]` (own + shared) | self |
| POST | `/api/views` | `{ name, scope, config: { filters, sort, columns, … }, isShared?, isDefault? }` | `SavedView` | self; `isShared` O M |
| GET | `/api/views/:id` | — | `SavedViewItem` | owner of the view, or shared |
| PATCH | `/api/views/:id` | `{ expectedVersion, name?, config?, isShared?, isDefault? }` | `SavedView` | owner of the view |
| DELETE | `/api/views/:id?expectedVersion=N` | (version in the query: `api.delete` sends no body) | `SavedView` (archived) | owner of the view |

## Settings · Workflows · Job types · Automations

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| GET | `/api/settings` | — | `SettingsView` | O M |
| PATCH | `/api/settings` | `{ expectedVersion, organisationName?, …any settings field }` | `UpdateSettingsResult { …, changedFields[] }` (no change → 200, empty list) | O |
| GET | `/api/settings/permissions` | — | `PermissionMatrixRow[]` | O M |
| GET | `/api/workflows` | — | `WorkflowListItem[]` | O M |
| POST | `/api/workflows` | `{ name, description?, from?: default\|workflow\|blank, sourceWorkflowId?, isDefault? }` | `WorkflowGraph` | O |
| GET | `/api/workflows/:id` | — | `WorkflowGraph` | O M |
| PATCH | `/api/workflows/:id` | `{ expectedVersion, name?, description?, isDefault?: true }` | `WorkflowGraph` | O |
| POST | `/api/workflows/:id/archive` | `{ expectedVersion }` | `Workflow` | O |
| POST | `/api/workflows/:id/statuses` | `{ name, category, key?, colour?, description?, sortOrder?, isInitial? }` | `{ status, graph }` | O |
| POST | `/api/workflows/:id/reorder` | `{ statusIds[] }` (every live status, new order) | `WorkflowGraph` | O |
| POST | `/api/workflows/:id/transitions` | `{ fromStatusId, toStatusId, allowedRoles[], label?, requiresAssignedEditor?, assigneeOnly?, isReopen? }` | `{ transition, graph }` | O |
| PATCH | `/api/statuses/:id` | `{ expectedVersion, name?, category?, colour?, description?, isInitial?: true }` | `UpdateStatusResult` | O |
| POST | `/api/statuses/:id/archive` | `{ expectedVersion }` (blocked while jobs sit in it) | `{ status, graph }` | O |
| PATCH | `/api/transitions/:id` | `{ label?, allowedRoles?, requiresAssignedEditor?, assigneeOnly?, isReopen? }` | `{ transition, graph }` | O |
| POST | `/api/transitions/:id/archive` | — | `{ transition, graph }` | O |
| GET | `/api/job-types` | `includeArchived=1` | `JobTypeView[]` | all (create-job form) |
| POST | `/api/job-types` | `{ name, colour?, workflowId?, defaultEstimatedHours?, sortOrder? }` | `JobType` | O M |
| PATCH | `/api/job-types/:id` | `{ expectedVersion, name?, colour?, workflowId?, defaultEstimatedHours?, sortOrder? }` | `JobType` | O M |
| POST | `/api/job-types/:id/archive` · `/restore` | `{ expectedVersion }` | `JobType` | O M |
| GET | `/api/automations` | `includeArchived=1` | `AutomationListItem[]` | O M |
| POST | `/api/automations` | `CreateAutomationInput { name, description?, trigger, conditions?, actions, isEnabled?, sortOrder? }` | `Automation` | O M |
| GET | `/api/automations/:id` | — | `AutomationDetail` | O M |
| PATCH | `/api/automations/:id` | `{ expectedVersion, …fields }` | `Automation` | O M |
| POST | `/api/automations/:id/toggle` | `{ expectedVersion, isEnabled? }` (omitted = flip) | `Automation` | O M |
| POST | `/api/automations/:id/archive` | `{ expectedVersion }` | `Automation` | O M |
| POST | `/api/automations/:id/dry-run` | `{ jobId, triggerEventId? }` | `AutomationDryRunResult` (no writes) | O M |
| GET | `/api/automations/:id/runs` | `status, jobId, cursor, limit` | `Paginated<AutomationRunView>` | O M |
| GET | `/api/automation-runs` | `automationId, status, jobId, cursor, limit` | `Paginated<AutomationRunView>` | O M |

## System (existing)

| Method | Path | Response | Who |
|---|---|---|---|
| POST | `/api/system/sweep` | `SweepResult` | O M |
| GET | `/api/system/integrity` | `IntegrityReport { ok, drift[], structural[] }` | O |

There are no hard deletes: `DELETE` exists only for the soft comment delete and saved views (archive).

## Client-side pattern

```ts
try {
  const res = await api.post<TransitionResult>(`/api/jobs/${job.id}/approve`, { expectedVersion: job.version });
  res.warnings.forEach((w) => toast.warning(w));
  toast.success("Approved");
  router.refresh();
} catch (err) {
  if (err instanceof ApiError && err.isConflict) openConflictDialog(err.current);
  else if (err instanceof ApiError && err.code === "validation") setFieldErrors(err.fieldErrors);
  else toast.error(errorMessage(err));
}
```
