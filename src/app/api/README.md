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
| POST | `/api/auth/login` | `{ email, password, next? }` | `{ user, redirectTo }` + cookie + the known-device cookie `pl_known_device` (`redirectTo` = `loginRedirectTarget`: clients `/portal`, editors `/my-jobs`, else `next` or `/home`; `next` must survive `safeNextPath` — a same-site path with no control character or backslash anywhere). Wrong password, inactive account, an invite not yet accepted, a Google-only account, a client whose portal is off and (with `DEMO_SIGN_IN=off`) a demo-studio person all get the same 401 "Incorrect email or password"; audits `auth.logged_in` with `metadata.method: "password"` | public; failures limited 5 / 15 min per email + IP and 20 / 15 min per email — a browser that signed in to that address before (known device) counts only its own 5 / 15 min instead — plus 100 / 15 min per known IP → 429 "Too many sign-in attempts. Try again in N minutes." (a reset clears it) |
| POST | `/api/auth/logout` | — | `{ ok }` (HTML form → 303 `/login?logged_out=1`). Bumps `session_version` (every device logged out) — except in the demo studio, where only this browser's cookie is cleared (`auth.logged_out` metadata `{ allSessionsRevoked: false, demo: true }`) | any |
| GET | `/api/auth/me` | — | staff: `{ kind: "staff", user (+ persona, personaLabel, isAdmin, isPrimaryOwner, 7 effective switches), organisation, settings, unreadCount }` · client: `{ kind: "client", name, email, clientName, studioName, unreadCount }` only | signed in (`requireAnyContext`) |
| POST | `/api/auth/change-password` | `{ current, next }` | ok; other sessions revoked, a pending email change is cancelled, "Your password was changed" is emailed. Wrong current password → 400 `fieldErrors.current = ["That password isn’t right"]`; a Google-only account (no password) → 400 `fieldErrors.current`; demo studio → 403 | self |

### Front door (public — no session; CSRF Origin check + rate limits still apply; `src/proxy.ts` lets `/`, `/signup`, `/forgot-password`, `/reset-password`, `/invite/*`, `/verify-email`, `/change-email`, `/signup/google` and `/api/auth/*` through)

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `SignUpInput` (strict) `{ ownerName, email, password (>= 10), studioName (2-80), timezone? (IANA), website? }` | `{ organisationId, slug, user: { id, name, email, role: "photographer" }, redirectTo: "/home", emailConfirmation: { sent, reason, devLink?, expiresAt? } }` + staff cookie. `emailConfirmation` = the "Confirm your email" send (`devLink` only outside production without a mail provider). ONE transaction: organisation + settings defaults + owner (admin, primary owner, every switch on, `accepted_at = now`) + the default workflow + the types of shoot (`bootstrapOrganisation`, the same function the demo seed runs); events `org.created` / `user.created` / ... with cause `signup`. Taken email (any org, any role) -> 400 `validation` with `fieldErrors.email = ["That email is already in use. Try signing in."]` (same timing as success); an address with an unopened invite -> `fieldErrors.email = ["This email has been invited to a studio. Use the invite link in your email, or ask the studio to send it again."]`; the honeypot `website` filled -> one generic 400 "Something went wrong. Please try again." (checked before validation; still counted) | public; `RATE_LIMITS.signup` 5 / hour / IP (per email when no client IP is known) -> 429 "Too many new studios from this network. Try again in N minutes." + `retry-after`. A form with mistakes whose email would be looked up ("in use" / "invited" in the same 400) counts too — the lookup only runs inside the limit (SEC-04) |
| POST | `/api/auth/forgot-password` | `{ email }` | ALWAYS `{ ok: true, emailed }` - never says whether the address has an account. A 60-minute single-use token is created (and emailed when email is configured) only for an active, accepted user outside the demo studio (a Google-only account included: the reset gives it a password); older live tokens of that user are superseded; audited `auth.password_reset_requested` (management). Local dev without email also returns `resetUrl` (never in production) | public; `RATE_LIMITS.passwordReset` 5 / 15 min per email + IP -> 429 "Too many reset emails asked for. Try again in N minutes." |
| POST | `/api/auth/reset-password` | `{ token, password (>= 10) }` | `{ ok: true, redirectTo }` + cookie. Sets the password (`has_password = true`), confirms the email (`via "reset"`), bumps `session_version` (every other session dies), cancels a waiting email change, forgets the wrong sign-in passwords typed for the address (the new one works at once), remembers this browser for it, marks the token used, audits `user.password_changed` (cause `reset`), emails "Your password was changed". A reset link sent to an address the account no longer has is dead (any email change uses up live reset links). Unknown / expired / used link (or a demo-studio person) -> 400 `validation` "This reset link is no longer valid" | public; dead links 10 / 15 min per KNOWN client IP (`RATE_LIMITS.resetLink`, checked before hashing) -> 429 "Too many tries with reset links that no longer work. Try again in N minutes." |
| GET | `/api/auth/invite/:token` | - | live link: `{ valid: true, studioName, inviterName, role, persona, personaLabel, email, name, expiresAt }` - anything else: `{ valid: false }` (200; unknown / expired / used / revoked are indistinguishable). Tokens here, on `/invite/:token` and on the reset routes are URL-decoded and trimmed first (`cleanToken` / `TokenSchema`: a trailing `%20` from a mail client is forgiven); `/invite` with no token is a friendly dead-link page, not a 404 | public |
| POST | `/api/auth/invite/:token/accept` | `{ password (>= 10), name? }` | `{ user: { id, name, email, role }, redirectTo }` + cookie (staff, or client -> portal). Sets the password + `accepted_at` (+ name), bumps `session_version`, marks the token used, audits `user.accepted_invite` as the person. The email counts as confirmed only when the inviter's own email is confirmed and email is set up (SEC-05); otherwise "Confirm your email" is sent right after. Any invalid link (incl. a client whose portal is off, or any invite of a demo studio) -> 400 `validation` "This invite link is no longer valid" | public |

Links: `inviteUrl` = `${appOrigin}/invite/${token}`, reset = `${appOrigin}/reset-password?token=...`; `appOrigin(req?)` (`src/server/origin.ts`): production (`NODE_ENV=production`) = env `APP_URL` -> `APP_ORIGIN` -> the request origin -> `http://localhost:3000`; development / test = the request origin -> `APP_URL` -> `APP_ORIGIN` -> `http://localhost:3000` (so a stale `APP_URL` on a dev server never hands out a dead link). Settings -> Studio's email card notes when `APP_URL` differs from the page's own address (`linkOriginStatus`). Tokens are 32 random bytes (base64url), shown ONCE; only `sha256` hex is stored (`auth_tokens`, append-only, `used_at` fill-once). Email: `RESEND_API_KEY` + `EMAIL_FROM` -> provider `resend`; otherwise `console` (one log line, no token) and the UI shows the copyable link (`emailed: false`).

### Accounts (docs/ACCOUNTS.md; contract docs/ACCOUNTS-PLAN.md)

Self-service routes call `requireAnyContext()` (staff AND clients; 401 signed out); confirm routes are public. All
mutations are audited (§5 of the plan); a demo studio answers **403** with plain copy ("… in the demo studio") for
every change to a password, email, sign-in method or session. Every account email goes through `sendAccountEmail`
(never from a demo studio; nothing on behalf of an unconfirmed sender; `devLink` only outside production).
Sessions are 30-day sliding cookies (renewed by `src/proxy.ts` once older than 24 h). Rate limits are
Postgres-backed (`auth_rate_limits`; plan §2); 429 carries `retry-after` + `details.retryAfterSeconds`, and the
front-door / account 429s say what was limited in plain words ("Too many … Try again in N minutes.";
`rateLimitMessage` in `src/server/services/authLimits.ts`).

| Method | Path | Body / query | Response | Who |
|---|---|---|---|---|
| POST | `/api/auth/verify-email` | `{ token }` | `{ ok: true, email, signedIn, redirectTo }` — confirms the address the link was sent to (button press on `/verify-email`, never on GET). `redirectTo` = the signed-in person's home, else `/login?email=<email>`. Unknown / used / expired / for an old address → 400 "This confirmation link is no longer valid" with `details.reason` = `invalid` \| `expired` \| `used` \| `already_confirmed` (the page's next step). Never signs in | public |
| POST | `/api/auth/email-verification/resend` | — | `{ sent, reason, devLink?, expiresAt? }` (`reason`: `not_configured` \| `demo` \| `failed` \| null). A fresh 24-hour link; older ones stop working. Without a mail provider: production issues nothing; outside production the link IS issued and returned as `devLink`. Demo studio → `{ sent: false, reason: "demo" }`; already confirmed → 422 | self; 5 / hour → 429 |
| POST | `/api/auth/email-change` | `{ newEmail, password }` | email configured: `{ status: "pending", newEmail, expiresAt, sent, reason, devLink? }` (link to the NEW address, notice to the old; `reason` = an account-email not-sent reason or null); not configured: `{ status: "changed", email }` (applies at once, unconfirmed; `user.email_changed` via `direct`). Wrong password → 400 `fieldErrors.password` (counts toward `passwordCheck`, 10 / 15 min, shared with change-password); taken / same → 400 `fieldErrors.newEmail`; no password yet → 422; demo → 403 | self; 5 / hour → 429 "Too many email changes asked for. Try again in N minutes." |
| POST | `/api/auth/email-change/resend` | — | `{ status: "pending", newEmail, expiresAt, sent, reason, devLink? }` — "Send again" for a waiting change: a fresh link to the address already chosen (no password needed; the older link stops working; audited with `resend: true`). Nothing waiting → 422; the address taken by another account meanwhile → 400 `details.reason: "email_taken"` and the change is closed | self; shares the 5 / hour email-change limit |
| POST | `/api/auth/email-change/cancel` | — | `{ cancelled }` (0 = nothing was waiting); audits `user.email_change_cancelled` when something was | self |
| POST | `/api/auth/email-change/confirm` | `{ token }` | `{ ok: true, email, signedIn, redirectTo }` — the address changes now (confirmed; `user.email_changed` via `link` + `user.email_confirmed` via `email_change`); the old address gets "Your Proofline email was changed". `redirectTo` = `<account page>#email` when this browser is signed in as the same person, their home when signed in as someone else, else `/login?email=<new>`. Dead link → 400 `details.reason: "invalid_link"`; address taken meanwhile (or lost to a race) → 400 `details.reason: "email_taken"` and the waiting change is closed (`user.email_change_cancelled`, reason `taken`). Never signs in | public |
| POST | `/api/auth/set-password` | `{ password }` | `{ ok: true }` — only for an account without a password (Google sign-ups); otherwise 422. Needs a RECENT sign-in on this browser (the session cookie's `at`, within 15 minutes; SEC-03) → else 403 `forbidden` `details.action: "account.recent_sign_in"`. Nobody is logged out; "A password was added" is emailed; demo → 403 | self |
| POST | `/api/auth/sign-out-others` | — | `{ ok: true }` + this browser's cookie re-issued; every other session ends (`auth.other_sessions_revoked`) — the UI calls it "Log out of other devices"; demo → 403 | self |
| POST | `/api/auth/demo` | `{ persona: "owner" \| "photographer" \| "editor" \| "client" }` | `{ redirectTo, user: { id, name, role } }` + cookie — signs in as that seeded person of the `is_demo` studio (`startSession`, `auth.logged_in` method `demo`; never a known-device cookie). `DEMO_SIGN_IN=off` or no demo studio → 404 "The demo studio is turned off"; a persona that can't be opened right now → the generic 401 | public; 30 / 10 min / IP → 429 "Too many demo sign-ins from this network. Try again in N minutes." (not counted when the client IP is unknown) |
| GET | `/api/auth/google/start` | `?intent=signin\|signup\|invite&invite=<token>&next=<path>` | 302 to Google (state + nonce + PKCE S256 in a signed 10-minute httpOnly cookie scoped to `/api/auth/google`; `next` through `safeNextPath`, sign-in only). Not configured → 302 back to the page with `?google=disabled` (never a 404 or JSON); a bad query → `/login?google=failed`; `intent=connect` never starts a round trip (signed in → the account page's `#google` card, signed out → `/login`): use `POST /api/auth/google/connect` | public |
| POST | `/api/auth/google/connect` | `{ password }` | `{ redirectTo }` (Google's account chooser; the page navigates there) + the signed round-trip cookie — "Connect Google" on My account. The current password first (SEC-03): wrong → 400 `fieldErrors.password` (counts toward `passwordCheck`, 10 / 15 min, shared with change password / email); no password → 422; demo → 403; Google not configured → 404. The callback links Google and emails "Google sign-in was added to your Proofline account" to the account's address | self |
| GET | `/api/auth/google/callback` | `?code&state` (or `?error`) | 302: signed in (`loginRedirectTarget`), the invite accepted, or back to the page with `?google=<result>` (`cancelled`, `expired`, `failed`, `refused`, `use_password`, `unverified_email`, `linked_elsewhere`, `connected`, `disabled`), or `/signup/google` (`?from=signin` from the sign-in page) for a new person. Matching email: only when Google is the authority for the address (Gmail, or a Workspace account on its own domain) — otherwise `refused` — and never into an account that has a password (`use_password`: sign in with it, then Connect Google; SEC-01); a pending invitee with a live invite joins, a password-less account is linked. The round-trip cookie is cleared on every call | public; 30 / 15 min / IP (over → `failed`; not counted when the client IP is unknown) |
| POST | `/api/auth/google/complete` | `{ studioName, ownerName?, timezone?, website? }` + the signed `/signup/google` cookie (15 min) | `{ organisationId, slug, user, redirectTo }` + cookie (`redirectTo` = `/home`, or a sign-in's safe `next`) — the studio and its Google-only owner (no password, email confirmed, `user.google_connected` via `signup`). No / expired cookie → 400 "Start again with Continue with Google" (`details.reason: "google_signup_expired"`); honeypot → the email sign-up's generic 400 (still counted); taken email / unopened invite / Google account taken (race) → 400 | public; the sign-up limit (5 / hour, shared with the email sign-up) |
| POST | `/api/auth/google/disconnect` | — | `{ ok: true, disconnected }`; no password yet → 422; demo → 403. Works even after Google sign-in is switched off | self |

`POST /api/auth/signup` also accepts the honeypot `website` (filled → generic 400) and, after the studio is created,
sends "Confirm your email" (production without a mail provider: nothing; development: a dev-only `devLink` in
`emailConfirmation`). An email of a pending invitee → 400
`fieldErrors.email` "This email has been invited to a studio. Use the invite link in your email, or ask the studio
to send it again." `POST /api/users` and `/api/users/:id/invite/resend` return `notSentReason` next to `emailed`
(`unconfirmed_sender` = the inviter must confirm their own email before invites go out by email).

Demo studio (`organisations.is_demo`; docs/ACCOUNTS.md §7): `POST /api/users` (invite), `/api/users/:id/invite/resend`
and `/revoke`, client portal invites, `/api/users/:id/reset-password` (temp password), changing someone's email, primary
owner transfer, role / admin / permission switches / deactivate / anonymise on the four persona accounts, and switching
off the online access of — or archiving — the client the Client persona belongs to (`POST /api/clients/:id/portal`
`{ portalEnabled: false }`, `POST /api/clients/:id/archive`) all answer **403** with plain copy (e.g. "Invites are turned
off in the demo studio"; "The demo accounts can't be changed. Create your own studio to try this.").

Every response through `src/proxy.ts` carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors
'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. A path with broken
percent-encoding never reaches a route: `/api/*` → 400 `validation` "This address is not valid"; `/invite/…` → 307 to
the dead-link card.

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
| POST | `/api/users` | `InviteUserInput` (strict, by `role`): photographer `{ email, name, title?, capacityHoursPerWeek?, isAdmin?, flags?: {member switches} }` (omitted switches = invite defaults: review off) · editor `{ …, flags?: { canCreateJobs?, canViewTeamJobs? } }` · client `{ email, name, clientId }` (portal must be on, else 422). Plus `method?: "link" \| "temp_password"` (default `"link"`). Email used anywhere → 409 | `method: "link"` → `{ user, method: "link", inviteUrl, emailed, expiresAt }` — the person has NO usable password until they open the link (`accepted_at` null; login refused); `emailed` true when the link was emailed, else show `inviteUrl` to copy. `method: "temp_password"` → `{ user, method: "temp_password", tempPassword }` (show once; accepted at once) | A |
| POST | `/api/users/:id/invite/resend` | — | `{ inviteUrl, emailed, expiresAt }` — a fresh 7-day link for a pending person; every older link stops working (audited `user.invite_sent` with `resend: true`). Already joined / deactivated → 422 | A |
| POST | `/api/users/:id/invite/revoke` | — | `{ userId, revoked }` — every live invite link of a pending person stops working (`revoked` = how many; 0 is still a success; audited `user.invite_revoked`). The account stays, with no way in. Already joined → 422 | A |
| GET | `/api/users/options` | `role` (one, comma list or repeated), `jobId` (only people who may view that job — @mentions), `includeInactive=1`, `excludeSelf=1`, `q` | `UserOption[] { id, name, role, avatarColour, isActive, workload: { band, active, overdue } \| null }` — workload only for editors and only when the actor may view team workloads | user.view (`jobId` not visible → 404) |
| GET | `/api/users/:id` | — | `UserDetailView` | user.view (reduced for M/E; a client user's id → 404 for non-admins) |
| PATCH | `/api/users/:id` | `{ expectedVersion, name?, title?, avatarColour?, email? }` | `SafeUser` | A (email: `user.change_email`; never the primary owner unless self); self (name/title/avatar) |
| POST | `/api/users/:id/role` | `{ role, expectedVersion }` | `SafeUser` | A (photographer ⇄ editor only; never self; never the primary owner) |
| POST | `/api/users/:id/deactivate` | `{ expectedVersion, reassignTo? \| unassign?, reason? }` | `DeactivateResult` | A (not self, not the primary owner, last-admin guard) |
| POST | `/api/users/:id/reactivate` | `{ expectedVersion }` | `SafeUser` | A |
| POST | `/api/users/:id/reset-password` | — | `{ userId, tempPassword }` (sessions revoked; on a still-pending invitee it also sets `accepted_at` and kills their live invite link) | A (staff and client users; not the primary owner); self |
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
| GET | `/api/settings/email` | — | `EmailSettingsView { configured, provider: "resend" \| "console", from, notificationsEnabled }` — whether invite / reset links are emailed (`RESEND_API_KEY` + `EMAIL_FROM`) or must be copied from the screen; `notificationsEnabled` mirrors the reserved `organisation_settings.email_notifications_enabled` | A (`settings.view`) |
| GET | `/api/settings/onboarding` | — | `OnboardingState \| null` — first-run checklist for admins (`steps { createdFirstJob, invitedEditor, addedClient, assignedEditor, approvedFirst }`, `completed`, `total: 5`, `dismissed`, `dismissedAt`, `isNewStudio` (< 3 jobs and < 30 days), `jobCount`, `studioAgeDays`, `show`); `null` for everyone else (`src/server/queries/onboarding.ts`) | signed-in staff (admins get data) |
| POST | `/api/settings/onboarding/dismiss` | — | `{ dismissedAt, changed }` — hides the checklist for every admin of the studio (idempotent; audited `settings.updated`, field `onboardingDismissedAt`) | A (`settings.manage`) |
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

Client users are invited with `POST /api/users { role: "client", clientId, name, email }` — by default an invite link they open at `/invite/:token` to choose their password (the portal must be on when they accept); reset / deactivate / reactivate / invite resend / revoke use the normal user routes.

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
