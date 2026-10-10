# Proofline

Work management for photography studios. Proofline shows every job, who is working on it, what stage it is at, what is overdue, what each editor is doing, how fast work turns around, every revision and the complete history of every piece of work.

It is **not** a media store. Raw files, editing workspaces and finished galleries stay where they already live (Google Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom, Pixieset…). Proofline keeps the links and manages the work and the people.

- Product brief: [`docs/PRODUCT-SPEC.md`](docs/PRODUCT-SPEC.md)
- Architecture, data model, permissions, workflow engine, API and page map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (source of truth)
- Roles, permissions, client portal and sharing (roles v2 contract): [`docs/ROLES.md`](docs/ROLES.md)
- REST contract for the UI: [`src/app/api/README.md`](src/app/api/README.md)
- Agent and contributor conventions: [`CLAUDE.md`](CLAUDE.md)

## Features

| Area | What you get |
|---|---|
| **Dashboard** | 8 KPI cards, bottleneck banners, editor workload (🟢🟡🔴 capacity bands), due-today/overdue lists, recent activity and performance widgets. Each user can rearrange, resize and hide widgets (`?customise=1`). Admins (and team members who see all jobs) switch between **My shoots** and **Whole business** from the topbar without changing accounts; editors get a focused personal variant. |
| **Workspace** | **All Work** table (sort, filter, group, column chooser, saved views, bulk reassign/priority/status for admins, `j/k/x` keys) · **My Work** queue (overdue, due today, revisions, waiting for review, paused) · **Team Work** · **Kanban** (drag and drop through the workflow with permission-checked moves) · **Calendar** (month/week/day/agenda) · **Timeline** (Gantt with bottleneck highlighting). |
| **Jobs** | Create/edit forms (client → project cascade, job type → workflow, editor picker with workload). The detail page has next-step actions and a timer, plus tabs for Overview (Finished Work panel), Links, Notes, Comments (@mentions), Revisions, Timeline, Activity, History and Time. |
| **Workflow engine** | Configurable statuses and transitions per workflow, role and assignee rules, reopen/revision flows, overrides with reason. Every status change goes through one audited service. |
| **Audit trail** | Append-only `activity_events` with before/after values, enforced by DB triggers. Global Activity Log with filters, diff view and CSV export. |
| **Production** | Clients and projects with open/overdue/completed counts, progress, key dates and activity. |
| **Team** | Photographer/editor directories, person pages (workload history, time per stage, completed work), workloads with inline capacity editing and a reassign drawer, performance leaderboards. |
| **Insights** | Analytics (volume, on-time and revision trends, turnaround, utilisation), bottleneck detection with quick fixes, Production/Editors/Photographers/Business reports with CSV download and print styles. |
| **Settings** | Organisation (timezone, thresholds, SLA, default photographer for editor-created jobs, time tracking), users (invite photographers / editors / client users, admin grant, per-person permission switches, capacity, deactivate with reassignment, anonymise, primary-owner transfer), roles matrix, teams, workflows editor, job types, automations builder with dry run and run history, notification preferences, profile, appearance (theme and density). |
| **Client portal** | Optional per client: client users sign in to `/portal` and see only the jobs and projects the studio shared with them — milestones (Booked → Shot → Editing → Delivered), agreed dates, shared finished-work links, delivery notes and feedback threads. Staff share jobs, projects and single links, deliver with a Deliver dialog that picks the links to publish, and reply to feedback; internal notes and comments never reach the portal. |
| **Everywhere** | ⌘K / Ctrl K command palette and global search (an exact job number such as `PJ-0042` jumps to that job's history), keyboard shortcuts (`?`), in-app notifications, optimistic-concurrency conflict dialogs, a mobile layout with a bottom tab bar, and light and dark themes. |

Roles (v2, contract [`docs/ROLES.md`](docs/ROLES.md)) — exactly three: **Photographer**, **Editor**, **Client**.

| Persona | Who | Can |
|---|---|---|
| **Owner / Photographer** | a photographer with admin (`users.is_admin`); exactly one is the *primary owner* | everything: all jobs, people, analytics, activity and settings; shoots too — their own shoots are ordinary jobs |
| **Photographer (team member)** | other photographers | their own jobs, plus what the owner switches on: create jobs, assign editors, review submissions, see team workload, see all jobs, analytics |
| **Editor** | editors | jobs assigned to them (accept, start, pause, notes, questions, finished-work links, submit, resubmit); create jobs for a photographer; optionally see other editors' jobs read-only |
| **Client** | client portal users of one client | only the work shared with them, in `/portal` |

Every page, query and service re-checks permissions server-side (ARCHITECTURE §3, ROLES.md §3). Pages a persona may not open return a real `403`; clients are sent to `/portal` and staff away from it. Records that are missing or not shared with the viewer return a `404`, so the response never reveals whether they exist.

## Stack

Next.js 16 (App Router, Turbopack, `proxy.ts`), React 19, TypeScript (strict), Tailwind CSS v4 · Drizzle ORM on Postgres (Supabase in production, PGlite locally) · Zod 4 · jose (signed session cookies) + bcryptjs · lucide-react, @dnd-kit, recharts, cmdk, date-fns · Vitest + Playwright.

## Getting started

Requires Node.js 20+. No database server and no env file are needed locally: dev and tests run on PGlite (Postgres 17 in WASM, in-process, data in `./data/pglite`).

```bash
npm install
npm run db:reset            # fresh ./data/pglite: migrations (incl. integrity triggers), seed demo data, verify
npm run dev                 # http://localhost:3000
```

With no `SESSION_SECRET`, the dev server generates one once into `data/.session-secret` (gitignored). To configure things, `cp .env.example .env`: `SESSION_SECRET` (≥ 32 chars; **required in production**), `PGLITE_DATA_DIR` (default `./data/pglite`), `APP_URL`, and optional `CRON_SECRET` (≥ 32 chars). With `CRON_SECRET` set, a scheduler can call `GET /api/system/cron/sweep` with `Authorization: Bearer <CRON_SECRET>` every few minutes so overdue alerts fire even when nobody has the app open. Never put `DATABASE_URL` in `.env`/`.env.local`: when it is set, the app talks to that Postgres instead of PGlite.

### Demo accounts

All seeded accounts use the password `Password123!`.

| Account | Shown as | Notes |
|---|---|---|
| `owner@studio.test` | Owner / Photographer | Admin and primary owner: runs the business, shoots (~12 % of jobs), reviews and delivers |
| `photographer01@studio.test` | Photographer (team member) | Sees all jobs, team workloads and analytics; reviews their own shoots |
| `photographer02@studio.test` … `photographer11@studio.test` | Photographer (team member) | Own jobs; create, assign editors and review their own shoots |
| `photographer12@studio.test` | Photographer (team member) | Junior at invite defaults: the owner assigns editors and reviews her work |
| `editor01@studio.test` … `editor13@studio.test` | Editor | `editor02` sees other editors' jobs (read-only); `editor03` is overloaded; `editor09` cannot create jobs; `editor11` and `editor13` are deactivated |
| `client@studio.test` | Client | Harbourline Realty portal user (shared projects and jobs, delivered links, a feedback thread) |
| `client2@studio.test` | Client | Coastal Key Property portal user; nothing shared yet (empty state), feedback off |
| `owner@other.test`, `editor@other.test`, `client@other.test` | (second studio) | For tenant-isolation checks |

The full roster is in `src/db/seed/catalog.ts`. The seed runs the real services under a fake clock, so the history, revisions, audit events and metrics are all consistent with each other.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run test` | Vitest unit and integration tests (`src/**/*.test.ts`) |
| `npm run e2e` | Playwright (`e2e/`; starts its own dev server on :3100 with `data/pglite-e2e`) |
| `npm run db:reset` | Dev only (local PGlite; refuses when `DATABASE_URL` is set): delete `./data/pglite`, migrate (schema + guards), seed, verify |
| `npm run db:migrate` · `db:seed` · `db:verify` | Individual steps (`db:seed` refuses to run if data already exists) |
| `npm run db:migrate:remote` · `db:seed:remote [-- --wipe]` · `db:verify:remote` | Supabase maintenance; reads `.env.supabase` (never committed) — see [Supabase](#supabase-production-database) |
| `npm run db:verify` | Recompute every derived job column from the ledgers; must report 0 drift |

After any change to `src/db/schema.ts`, run `npx drizzle-kit generate` (the committed `drizzle/` DDL feeds the test database).

## Architecture in one screen

```
src/app/(auth)/login              public sign-in
src/app/(app)/…                   authenticated pages (async Server Components) + loading/error boundaries
src/app/api/**/route.ts           thin REST handlers → one service or query (src/app/api/_lib/route.ts)
src/server/services/*             every write: permission check → Zod → transaction → audit event
src/server/queries/*              read models for pages (org-scoped, visibility-scoped)
src/server/auth/*                 session, passwords, the permission POLICY (can / visibleJobsWhere)
src/server/page.ts                page helpers: pageContext, guard, allowed, load, param(s)
src/components/ui · shell         design-system primitives and the app chrome
src/components/<feature>          feature components (jobs, work-table, job-detail, kanban, dashboard, …)
src/lib/*                         pure helpers, types, constants, validation, dates (org timezone)
src/db/*                          schema, client, guard triggers, seed, verify
```

Conventions that matter when adding a page:

- **Data**: pages are async Server Components that call `pageContext()`, then `guard(ctx, action)`, then `load(() => query(db, ctx, …))`. Interactivity lives in small `"use client"` islands that call the REST API through `src/lib/api-client.ts` and then `router.refresh()`. Filters, sort and tabs live in URL search params.
- **Writes**: send `expectedVersion`. A `409` opens the shared `ConflictDialog`; validation errors map to fields.
- **Real status codes**: a segment's `loading.tsx` starts streaming, after which the status is locked at 200. So permission and existence gates that should return a real 403/404 sit in a `layout.tsx` above the loading boundary (see `jobs/[id]/layout.tsx`, `settings/*/layout.tsx`). List pages whose segment has child routes keep their `page`/`loading`/`error` in a `(list)` route group, so the list skeleton does not wrap the children.
- **Shared UI**: status, priority, due, person, workload and capacity display pieces and all job actions are in `@/components/jobs`. Filters are in `@/components/filters` and `SectionCard`/`StatTile`/`RouteError` are in `@/components/common`. Reuse them rather than writing local copies.
- **Navigation**: `src/config/nav.ts` items carry an optional `gate` (`admin`, `createJobs`, `createClients`, `teamWork`, `directory`, `teamWorkloads`, `analytics`) computed server-side by `navGatesFor(ctx)` (`src/server/nav-gates.ts`); for example a team member with "See analytics" sees Insights. Clients use `portalNavigation` in `src/app/portal`.

## Supabase (production database)

Production data lives in Supabase Postgres 17. The connection strings live in `.env.supabase` at the project root — gitignored, **never** loaded by Next.js, never printed by any script:

```bash
# .env.supabase
DATABASE_URL=postgresql://…pooler.supabase.com:6543/postgres   # transaction pooler — runtime (prepare: false)
DIRECT_URL=postgresql://…pooler.supabase.com:5432/postgres     # session pooler — migrations, bulk loads, verify
```

| Command | What it does |
|---|---|
| `npm run db:migrate:remote` | `drizzle-kit migrate` against `DIRECT_URL`: the tables + the integrity triggers (`drizzle/0001_guards.sql`, `drizzle/0003_roles_v2_data.sql`; 0003 also migrates v1 owner/manager data — answer ROLES.md §16 Q2/Q3 before running it on existing data). Safe to re-run. |
| `npm run db:seed:remote` | Seeds a fresh in-memory PGlite through the real services, then copies every table to Supabase in ONE transaction and verifies it. Refuses (before seeding) when the target is not migrated or already has rows. |
| `npm run db:seed:remote -- --wipe` | Same, but first truncates every app table in that transaction — **replaces all remote data** with the demo data. |
| `npm run db:verify:remote` | Recomputes every derived job column on Supabase from the ledgers; must report 0 drift. |
| `node scripts/start-remote.mjs [port]` | After `npx next build`: runs `next start` (default :3160) with `DATABASE_URL` from `.env.supabase` in the child process only — a production-mode check from a workstation. |

`REMOTE_ENV_FILE=<file>` points all of the above at another env file (for example a local Postgres to rehearse a cutover). See `docs/POSTGRES-MIGRATION.md`.

## Deploying to Vercel

Set these Vercel environment variables (Production, and Preview if previews should have a database):

- `DATABASE_URL` — Supabase **transaction pooler** (port 6543); the app connects with `prepare: false`.
- `DIRECT_URL` — Supabase **session pooler** (port 5432); `vercel-build` runs `drizzle-kit migrate` against it before `next build` (skipped when unset).
- `SESSION_SECRET` (≥ 32 chars, required), optional `CRON_SECRET`.

- **Overdue alerts on a schedule (optional):** set `CRON_SECRET` and point a scheduler at `GET /api/system/cron/sweep` with `Authorization: Bearer <CRON_SECRET>`.
- **Region:** pick the Vercel region closest to your Supabase project (for Australia, Sydney `syd1`).

## Testing

```bash
npm run typecheck && npm run lint && npm run test
npm run db:verify          # ledger ↔ derived-column integrity on the dev DB (must report 0 drift)
npm run e2e                # Playwright, desktop + mobile projects
```

The Vitest suite covers the permission policy, the workflow engine and side effects, services (audit in the same transaction), queries, metrics, automations, date maths (DST), the REST surface (every route answers every method with JSON) and the seed invariants. Each test gets a fresh in-memory PGlite database built from `drizzle/` via `makeTestDb()`.

### End-to-end (Playwright)

Two ways to run it:

| Mode | Command | What happens |
|---|---|---|
| Own server (default) | `npm run e2e` | Playwright resets `data/pglite-e2e` (`npm run e2e:prepare`: delete → migrate → seed → verify), starts `next dev` on **:3100** against it, runs both projects. If something already listens on :3100 it is reused **without** a reset — stop it, or run `npm run e2e:prepare` first. |
| Existing server | `E2E_BASE_URL=http://localhost:3000 npx playwright test` | No server is started and no database is reset: specs create every job, client and user they need through the API, so they also run against a shared, already-seeded dev server. |

- Projects: `desktop` (1440×900, every spec except `mobile.spec.ts`) and `mobile` (390×844 touch, `mobile.spec.ts`). Run one with `npm run e2e:desktop` / `npm run e2e:mobile`, or a single file with `npx playwright test e2e/kanban.spec.ts`.
- One worker, no retries by default (`E2E_RETRIES=n` to allow some). Pages wait for hydration and the dev-server HMR socket is muted so other people's edits cannot reload a page mid-test (`E2E_KEEP_HMR=1` to keep it).
- Output: `test-results/` and `playwright-report/` (`npx playwright show-report`); override with `E2E_OUTPUT_DIR` / `E2E_REPORT_DIR` when several runs share a checkout.
- Layout: `e2e/api.ts` (server URL, seeded accounts, REST client and data factories), `e2e/fixtures.ts` (role fixtures — `test.use({ role: "editor" })`, `api`, `apiAs`, `pageAs`, `loginAs`, `pageWithState` — plus UI/layout helpers), one spec per area of spec §40 (`auth`, `permissions`, `job-create`, `assignment`, `status-flow`, `kanban`, `revisions`, `comments`, `links`, `notifications`, `activity-audit`, `filters-search`, `calendar-timeline`, `dashboard`, `edge-cases`, `mobile`), the roles v2 personas (`roles-owner`, `roles-team-photographer`, `roles-editor`, `client-portal`, `stacking`) and `regression-*.spec.ts` for audit regressions.
- Seeded accounts are only ever signed in through their own cookie jars; tests that log out, deactivate or anonymise users invite their own.
