# Photographer Work Management Platform

Standalone product (NOT part of ListingsReady; the ListingsReady cross-platform rule does not apply here).
Product brief: `docs/PRODUCT-SPEC.md`. **The simplified product (what every screen is built around): `docs/SIMPLIFICATION-PLAN.md`** — five stages, one Jobs list, ≤ 5 menu items, plain words (its glossary bans turnaround / utilisation / capacity hours / bands / bottleneck / workflow / Kanban / All Work / Team Work / My Work / Dashboard in the simplified UI). Architecture + data model: `docs/ARCHITECTURE.md` (source of truth; §10 is the page map).

## Stack (fixed — do not swap libraries)
- Next.js 16.4 App Router (`src/app`), React 19, TypeScript strict, Tailwind CSS v4 (`src/app/globals.css` holds design tokens).
- Drizzle ORM on **Postgres** (ASYNC everywhere): production = Supabase via `postgres` (postgres-js, `DATABASE_URL`); local dev/tests/e2e = PGlite (in-process Postgres, `PGLITE_DATA_DIR`, default `./data/pglite`). Schema `src/db/schema.ts` (pg-core); client `src/db/index.ts`; migrations `drizzle/` (integrity triggers in `drizzle/0001_guards.sql`). Conversion rules: `docs/POSTGRES-MIGRATION.md`.
- Zod 4 for validation (`import { z } from "zod"`), jose for signed session cookies, bcryptjs for passwords.
- UI: lucide-react icons, @dnd-kit (the Advanced Board), recharts (charts), cmdk (command palette), date-fns (dates), `cn()` from `src/lib/utils.ts`.
- Tests: vitest (`src/**/*.test.ts`), Playwright (`e2e/`).

## Next.js 16 rules (this is NOT the Next.js you may remember)
- `params`, `searchParams`, `cookies()`, `headers()` are all **async** — always `await` them.
- `src/proxy.ts` replaces `middleware.ts` (export `proxy` + `config.matcher`).
- `cacheComponents` is OFF. Pages reading the DB are dynamic by default; never add `"use cache"`.
- Server Components by default; add `"use client"` only to interactive leaves.
- Generated route types exist: `PageProps<"/jobs/[id]">`, `LayoutProps<"/">`.
- `next lint` was removed: use `npm run lint` (eslint flat config). Turbopack is the default bundler.
- Docs are in `node_modules/next/dist/docs/01-app/**` if unsure.

## Architecture rules (non-negotiable)
1. **All mutations go through services** in `src/server/services/*.ts`. Route handlers (`src/app/api/**/route.ts`) and server actions are thin: parse → auth → call service → respond.
2. **Every service mutation**: (a) checks permission via `src/server/auth/permissions.ts`, (b) validates input with a Zod schema from `src/lib/validation/*`, (c) runs inside a DB transaction, (d) writes an `activity_events` row via `src/server/audit.ts` **in the same transaction**, with before/after values.
3. **Audit log is append-only.** There is no code path that updates or deletes `activity_events` rows. Never add one.
4. **Org scoping**: every query filters by `organisationId` of the current user. Never trust ids from the client without checking they belong to the user's org.
5. **Status changes** go through `transitionJobStatus()` in `src/server/services/workflow.ts` (which handles side effects, assignments, revision counters, notifications, automations). Never set `jobs.statusId` directly elsewhere.
6. Components never import `src/db` directly; they call `src/server/queries/*` (reads) or services via actions/API (writes).
7. Dates: stored as ISO-8601 UTC strings (`text`), displayed via helpers in `src/lib/dates.ts` using the organisation's timezone (default `Australia/Sydney`).
8. Ids: `nanoid()` strings. Jobs also get a human `jobNumber` like `PJ-0142`.

## Layout
```
src/app/(auth)/login            public auth pages
src/app/(app)/...               authenticated app (layout = sidebar + topbar)
src/app/api/**/route.ts         REST handlers
src/components/ui/*             design-system primitives (Button, Card, Table, Badge, Dialog, …)
src/components/*                feature components
src/server/auth/*               session, password, permissions
src/server/services/*           write-side domain logic (+ audit)
src/server/queries/*            read-side queries for pages
src/server/audit.ts             recordEvent()
src/lib/*                       shared pure helpers, validation, types, constants
src/db/*                        schema, client, migrate, seed
e2e/*                           Playwright
```

## Commands
`npm run dev` · `npm run build` · `npm run typecheck` · `npm run lint` · `npm run test` · `npm run db:generate` · `npm run db:migrate` · `npm run db:seed` · `npm run db:reset` · `npm run db:verify` · `npm run e2e` · remote: `npm run db:migrate:remote` · `npm run db:seed:remote [-- --wipe]` · `npm run db:verify:remote`

- `db:reset` (dev only, local PGlite only) = delete `./data/pglite` → `db:migrate` (schema + 31 integrity triggers: `drizzle/0001_guards.sql` + the roles-v2 guards in `drizzle/0003_roles_v2_data.sql`) → `db:seed` (real services under a fake clock; exits 1 on drift or a missed §39 minimum) → `db:verify`. Refuses when `DATABASE_URL` is set. Stop `npm run dev` first (one process per PGlite data dir). `db:seed` refuses to run when organisations already exist.
- `db:verify` recomputes every derived job column from the ledgers (same check as `GET /api/system/integrity`); must report 0 drift.
- After any `schema.ts` change run `npx drizzle-kit generate` (the freshness test in `src/db/test-db.test.ts` fails until you do). Trigger changes = a new custom migration.
- Env: local dev needs none (`npm install` → `npm run db:reset` → `npm run dev`; without `SESSION_SECRET` the dev server generates `data/.session-secret`). Optional `.env`: `SESSION_SECRET` (≥ 32 chars, REQUIRED in production), `PGLITE_DATA_DIR`, `CRON_SECRET`, `APP_URL` (public origin for invite / reset links), `RESEND_API_KEY` + `EMAIL_FROM` (real outbound email; otherwise the console provider logs one line and the UI shows the copyable link); see `.env.example`. Supabase URLs (`DATABASE_URL` = transaction pooler :6543, `DIRECT_URL` = session pooler :5432) live ONLY in `.env.supabase` (gitignored, not loaded by Next; never print them) and in Vercel env vars. Never put `DATABASE_URL` in `.env`/`.env.local`.
- Remote (Supabase): `db:migrate:remote` (schema + guards, idempotent) → `db:seed:remote` (refuses a non-empty target; `-- --wipe` REPLACES all remote data) → `db:verify:remote` (0 drift). Production-mode check: `npx next build` then `node scripts/start-remote.mjs 3160`. `REMOTE_ENV_FILE=<file>` retargets all of these (e.g. a local Postgres rehearsal). Remote writes need the user's explicit go-ahead.

Roles (v2, contract `docs/ROLES.md`): exactly three roles — `photographer`, `editor`, `client`. Admin is `users.is_admin` on a photographer (persona "Owner / Photographer"); other photographers are team members with permission switches. There are no owner/manager roles.

Front door (sign-up, invite links, password reset — server side; routes in `src/app/api/README.md` → "Front door"): `src/server/services/organisations.ts` (`createOrganisationWithOwner` + `bootstrapOrganisation` = the ONE studio bootstrap, shared by `signUp` and the demo seed `src/db/seed/org.ts`), `invites.ts` (`createInvite` / `resendInvite` / `revokeInvite` / `lookupInvite` / `acceptInvite` / `deliverInvite`), `passwordReset.ts` (`requestPasswordReset` / `resetPassword`), `src/server/auth/tokens.ts` (`auth_tokens` ledger: sha256 at rest, 7-day invite / 60-minute reset, `used_at` fill-once, migration `drizzle/0005_front_door.sql`), `src/server/email/*` (`sendEmail`, providers `resend` | `console`, templates), `src/server/origin.ts` (`appOrigin(req?)`), `src/server/queries/onboarding.ts` (first-run checklist). `inviteUser` defaults to `method: "link"`: the person has an UNUSABLE password and `accepted_at = null` until they accept (login refuses them with the generic message); `"temp_password"` is the fallback. Public API routes (`/api/auth/*`) skip `requireContext` but keep CSRF + rate limits; public pages in `src/proxy.ts`: `/`, `/signup`, `/forgot-password`, `/reset-password`, `/invite/*`. Invited / reset tokens are never stored, logged or audited in plain form (the audit redactor also drops any metadata KEY matching /password|secret|token/i — put such words in values, e.g. `method: "temp_password"`).

Demo login (seeded, all `Password123!`; default `SEED_PROFILE=small` = the plan's demo studio, `src/db/seed/small.ts`): `owner@studio.test` (Mo Carter, Owner: admin, primary owner, also shoots); `photographer01@studio.test` (Priya Nair, extra photographer, "Only their own shoots" preset); `editor01@studio.test` (Sam Whitfield, usual capacity 6), `editor02@studio.test` (Ava Mitchell), `editor03@studio.test` (Lucas Pham, usual capacity 4); client portal user `client@studio.test` (Harbourline Realty; Coastal Key Property has no portal). Second org for isolation tests: `owner@other.test`, `editor@other.test`, `client@other.test`. The 160-job / 25-person fixture is `SEED_PROFILE=full` (roster in `src/db/seed/catalog.ts`; e2e and the §39 checks use it). The shared dev DB accumulates test jobs from agents and e2e runs; a `db:reset` restores the small demo.

## Page conventions (simplified product — docs/SIMPLIFICATION-PLAN.md is the contract)
- Pages: `const { ctx, db } = await pageContext(); guard(ctx, "<action>"); const x = await load(() => query(db, ctx, …))` (`src/server/page.ts`). Client islands call `api` from `src/lib/api-client.ts` then `router.refresh()`; a 409 opens `ConflictDialog` (`useConflict` in `@/components/job-simple`); URL search params hold filter / tab state. Landing by role: `homePathFor(ctx)` (`/home`, editors `/my-jobs`, clients `/portal`) — never hard-code `/dashboard`.
- **Stages, not statuses, in the UI**: `src/lib/stages.ts` translates the 13 status categories into Needs editor · With editor · Ready to check · Changes asked · Done (+ Cancelled). Every list, card and header uses `StagePill` / `StageDot` / `RoundBadge` / `RushBadge` / `WaitingOn` from `@/components/jobs/stage-pill` and `SimpleDueChip` from `@/components/jobs-list`; the legacy `StatusPill` / `PriorityPill` / `DueChip` / `WorkloadBand` in `@/components/jobs` are for Advanced screens only. Plain words only — the plan's glossary drops turnaround, utilisation, capacity hours, bands, bottleneck, workflow, Kanban, All Work, Team Work, My Work, Dashboard from the simplified screens.
- **One dialog per action**: `AssignEditorDialog` (assign / change), `SendForCheckingDialog`, `ApproveButton` (share question + self-approval confirm), `AskForChangesDialog`, `ReopenDialog`, `CancelJobDialog`, `DeclineJobDialog`, `TakeBackDialog`, `RestoreButton`, `StartEditingButton` and `simpleJobApi` (every route path) live in `@/components/job-simple`; Home, My jobs and the Editors pages import them — never a local copy. Composite actions are `POST /api/jobs/:id/simple/<action>` → `src/server/services/simple.ts` (each underlying step still its own history row).
- **Real 403/404 status**: once a segment's `loading.tsx` streams, the status is locked at 200. Put permission / existence / Advanced gates in a `layout.tsx` ABOVE the loading boundary (e.g. `editors/layout.tsx`, `jobs/(list)/layout.tsx`, `settings/people/layout.tsx`). A segment with child routes keeps its own `page` / `loading` / `error` in a `(list)` or `(detail)` route group. `(app)/forbidden.tsx` and `(app)/not-found.tsx` render inside the app shell.
- **Hide, don't delete**: Advanced pages stay at their routes and call `requireAdvanced(ctx, feature)` (404) or `redirectUnlessAdvanced(ctx, feature, to)` (307) in their layout; hidden APIs 404 automatically when their path sits under an `ADVANCED_FEATURE_META[*].apiPrefixes` prefix (`src/app/api/_lib/advanced.ts`; raw-handle routes call `requireRouteContext(req)`). Old addresses redirect via `LEGACY_REDIRECTS` in `next.config.ts`. The feature switch is `organisation_settings.advanced_tools_enabled` (`PATCH /api/settings/advanced`; turned on automatically for studios with custom workflows or live automations).
- Nav visibility: `src/config/nav.ts` items take an optional `gate` (`photographer` / `editor` / `admin` / `createJobs` / `createClients` / `newJob` / `advanced` / …); `navGatesFor(ctx)` (`src/server/nav-gates.ts`) computes them with `can()` in `src/app/(app)/layout.tsx`, which also passes the phone tab bar's "to check" count. Clients use the portal (`src/app/portal`, `portalNavigation`) and never the staff shell.
- Permission refs for jobs: always `loadJobRef` / `loadJobRefs` (`src/server/auth/job-ref.ts`), never a hand-built `JobPermissionRef`. Self-approval: `selfReviewNeedsConfirm` (admins who edited the job) → the UI sends `confirmSelfApproval`; editors and non-admin photographers are blocked.
- Layering: use the z-index tokens in `globals.css` (`z-(--z-page-sticky)` 20 · `--z-shell` 30 · `--z-topbar` 40 · `--z-popover` 50 · `--z-toast` 100). No page element may reach `--z-topbar`; tooltips inside the fixed sidebar portal to `document.body`. The shell's `<main>` is `overflow-x-clip`; scroll wrappers around tables are `relative` so `sr-only` labels cannot widen the page; use `Tooltip align="end"` (or responsive overrides) for triggers near the right edge.
- Shell client components render on statically prerendered pages too (`/design-system`, dev-only in production): don't call `useSearchParams()` in them without a Suspense boundary.
- Next 16 allows ONE `next dev` per checkout. A route handler whose exports changed while the dev server was running can keep serving the old module until the file's CONTENT changes (an mtime touch is not enough) — edit a comment to force the recompile rather than restarting a shared server.
- Theme/density boot script is mounted once in the root layout (`AppearanceBoot`, next/script `beforeInteractive`).
- Screenshots of the simplified screens (desktop 1440×900 + phone 390×844) live in `docs/screenshots/simple/` (the pre-simplification `docs/screenshots/roles/` set was deleted with the old screens).
- **Phones**: the job page pins a compact `NextStepCard pinned` bar above the tab bar (sentence + buttons, ≤ ~96 px); the editor's finished-link box, "I updated the same link" and the quoted request open in `SendForCheckingDialog` from its primary button, and "See request" scrolls to `#changes`. The full card (inline form) is desktop-only (`hidden lg:block`).
- **Old UI is deleted, not kept**: the pre-simplification screen components (`components/my-work`, `work-table` except `scroll-fade.tsx`, `dashboard`, the tabbed `job-detail/*` tabs, the Team directory/person pages, the scope notice, the roles-notice card + route + query) are gone. `components/job-detail` keeps only `history-tab`, `mention-textarea` and `format`. Advanced screens that stay (Board, Timeline, Reports, Workloads, …) are hidden behind the switch, never deleted.
- **Advanced Board**: keeps 7 columns for now (With editor and Done are split so a drop maps to one status category) but every column header and jump chip is drawn with `columnTone` / `columnLabelParts` (`@/components/kanban/shared`), i.e. exactly the stage pill — plan §8 records the 5-column follow-up.
- **Settings → History** rows carry a plain-word category chip (`historyCategoryOf`: Sign-in / Job / People / Studio / Client) instead of "Owners only"; "Job" is implied on a job's own history page.

## Working agreements for agents
- Stay inside the files/areas you were assigned. Shared files (`schema.ts`, `types.ts`, `permissions.ts`, nav config, `components/ui/*`) are owned by the foundation; if you must change one, keep it minimal and additive and say so in your report.
- Run `npm run typecheck` (and `npm run lint` on your files) before reporting done. Report real results, not assumptions.
- Prefer server components + small client islands. No `any`. No `console.log` left behind.
- Every list/table page needs: loading state (`loading.tsx` or Skeleton), empty state, error boundary (`error.tsx`).
