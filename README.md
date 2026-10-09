# Proofline

Work management for photography studios. Proofline shows every job, who is working on it, what stage it is at, what is overdue, what each editor is doing, how fast work turns around, every revision and the complete history of every piece of work.

It is **not** a media store. Raw files, editing workspaces and finished galleries stay where they already live (Google Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom, Pixieset…). Proofline keeps the links and manages the work and the people.

- Product brief: [`docs/PRODUCT-SPEC.md`](docs/PRODUCT-SPEC.md)
- Architecture, data model, permissions, workflow engine, API and page map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (source of truth)
- REST contract for the UI: [`src/app/api/README.md`](src/app/api/README.md)
- Agent and contributor conventions: [`CLAUDE.md`](CLAUDE.md)

## Features

| Area | What you get |
|---|---|
| **Dashboard** | 8 KPI cards, bottleneck banners, editor workload (🟢🟡🔴 capacity bands), due-today/overdue lists, recent activity and performance widgets. Each user can rearrange, resize and hide widgets (`?customise=1`). Editors and photographers get a personal variant. |
| **Workspace** | **All Work** table (sort, filter, group, column chooser, saved views, bulk reassign/priority/status for managers, `j/k/x` keys) · **My Work** queue (overdue, due today, revisions, waiting for review, paused) · **Team Work** · **Kanban** (drag and drop through the workflow with permission-checked moves) · **Calendar** (month/week/day/agenda) · **Timeline** (Gantt with bottleneck highlighting). |
| **Jobs** | Create/edit forms (client → project cascade, job type → workflow, editor picker with workload). The detail page has next-step actions and a timer, plus tabs for Overview (Finished Work panel), Links, Notes, Comments (@mentions), Revisions, Timeline, Activity, History and Time. |
| **Workflow engine** | Configurable statuses and transitions per workflow, role and assignee rules, reopen/revision flows, overrides with reason. Every status change goes through one audited service. |
| **Audit trail** | Append-only `activity_events` with before/after values, enforced by DB triggers. Global Activity Log with filters, diff view and CSV export. |
| **Production** | Clients and projects with open/overdue/completed counts, progress, key dates and activity. |
| **Team** | Photographer/editor directories, person pages (workload history, time per stage, completed work), workloads with inline capacity editing and a reassign drawer, performance leaderboards. |
| **Insights** | Analytics (volume, on-time and revision trends, turnaround, utilisation), bottleneck detection with quick fixes, Production/Editors/Photographers/Business reports with CSV download and print styles. |
| **Settings** | Organisation (timezone, thresholds, SLA, visibility flags, time tracking), users (invite, roles, capacity, deactivate with reassignment, anonymise), roles matrix, teams, workflows editor, job types, automations builder with dry run and run history, notification preferences, profile, appearance (theme and density). |
| **Everywhere** | ⌘K / Ctrl K command palette and global search (an exact job number such as `PJ-0042` jumps to that job's history), keyboard shortcuts (`?`), in-app notifications, optimistic-concurrency conflict dialogs, a mobile layout with a bottom tab bar, and light and dark themes. |

Roles: **Owner**, **Manager**, **Photographer**, **Editor**. Every page, query and service re-checks permissions server-side (ARCHITECTURE §3). Pages a role may not open return a real `403`. Records that are missing or not shared with the viewer return a `404`, so the response never reveals whether they exist.

## Stack

Next.js 16 (App Router, Turbopack, `proxy.ts`), React 19, TypeScript (strict), Tailwind CSS v4 · Drizzle ORM + better-sqlite3 · Zod 4 · jose (signed session cookies) + bcryptjs · lucide-react, @dnd-kit, recharts, cmdk, date-fns · Vitest + Playwright.

## Getting started

Requires Node.js 20+ (better-sqlite3 builds a native module on install).

```bash
npm install
cp .env.example .env        # then set SESSION_SECRET to a random string of at least 32 characters
npm run db:reset            # create data/app.db, install integrity triggers, seed demo data (~15 s)
npm run dev                 # http://localhost:3000
```

`.env` keys: `SESSION_SECRET` (required, ≥ 32 chars), `DATABASE_PATH` (default `./data/app.db`), `APP_URL`, and optional `CRON_SECRET` (≥ 32 chars). With `CRON_SECRET` set, a scheduler can call `GET /api/system/cron/sweep` with `Authorization: Bearer <CRON_SECRET>` every few minutes so overdue alerts fire even when nobody has the app open.

### Demo accounts

All seeded accounts use the password `Password123!`.

| Account | Role | Notes |
|---|---|---|
| `owner@studio.test` | Owner | Full access |
| `manager1@studio.test`, `manager2@studio.test` | Manager | Studio settings are read-only for managers where the owner decides (organisation, workflows) |
| `photographer01@studio.test` | Photographer | Has the team-workload and analytics flags, so Workloads and Insights are open |
| `photographer02@studio.test` … `photographer12@studio.test` | Photographer | No extra flags |
| `editor01@studio.test` … `editor13@studio.test` | Editor | `editor03` is overloaded; `editor11` and `editor13` are deactivated |
| `owner@other.test` | Owner (second studio) | For tenant-isolation checks |

The full roster is in `src/db/seed/catalog.ts`. The seed runs the real services under a fake clock, so the history, revisions, audit events and metrics are all consistent with each other.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run test` | Vitest unit and integration tests (`src/**/*.test.ts`) |
| `npm run e2e` | Playwright (`e2e/`; starts its own dev server on :3100 with `data/e2e.db`) |
| `npm run db:reset` | Dev only: delete the DB, then push the schema, add the guards and seed |
| `npm run db:push` · `db:guard` · `db:seed` | Individual steps (`db:seed` refuses to run if data already exists) |
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
- **Navigation**: `src/config/nav.ts` filters by role, plus `grant`s for flag-based access (for example a photographer with `can_view_analytics` sees Insights).

## Deploying to Vercel (hosted demo)

The repo deploys to Vercel with no configuration. Import it at **vercel.com/new**, keep the detected Next.js preset and deploy. Vercel runs the `vercel-build` script, which seeds a fresh demo database (`data/demo.db`, through the real services) and then runs `next build`.

How the hosted demo works:

- **Database:** Vercel's filesystem is read-only, so each server instance copies the bundled demo database to `/tmp` on first request and runs on that copy (`src/db/index.ts`).
- **Data does not persist.** Changes last only as long as that server instance. A new instance (after idle time, a redeploy, or a scale-out) starts again from the seeded demo data. The demo data is dated to the deploy, so redeploy to refresh it.
- **Session secret:** set `SESSION_SECRET` (≥ 32 chars) in the project's environment variables. If you don't, the build generates a random one per deployment, so everyone is signed out on each deploy.
- **Overdue alerts on a schedule (optional):** set `CRON_SECRET` and point a scheduler at `GET /api/system/cron/sweep` with `Authorization: Bearer <CRON_SECRET>`.
- **Region:** pick the region closest to your studio in the project settings (for Australia, Sydney `syd1`).

For production use with saved data, the app needs a hosted database instead of the bundled SQLite file. The closest fit is a hosted SQLite service such as Turso (libSQL). That is a larger change because the data layer is synchronous today.

## Testing

```bash
npm run typecheck && npm run lint && npm run test
npm run db:verify          # ledger ↔ derived-column integrity on the dev DB (must report 0 drift)
npm run e2e                # Playwright, desktop + mobile projects
```

The Vitest suite covers the permission policy, the workflow engine and side effects, services (audit in the same transaction), queries, metrics, automations, date maths (DST), the REST surface (every route answers every method with JSON) and the seed invariants. It uses an in-memory DB built from `drizzle/` via `makeTestDb()`.

### End-to-end (Playwright)

Two ways to run it:

| Mode | Command | What happens |
|---|---|---|
| Own server (default) | `npm run e2e` | Playwright resets `data/e2e.db` (`npm run e2e:prepare`: reset → guard → seed), starts `next dev` on **:3100** against it, runs both projects. If something already listens on :3100 it is reused **without** a reset — stop it, or run `npm run e2e:prepare` first. |
| Existing server | `E2E_BASE_URL=http://localhost:3000 npx playwright test` | No server is started and no database is reset: specs create every job, client and user they need through the API, so they also run against a shared, already-seeded dev server. |

- Projects: `desktop` (1440×900, every spec except `mobile.spec.ts`) and `mobile` (390×844 touch, `mobile.spec.ts`). Run one with `npm run e2e:desktop` / `npm run e2e:mobile`, or a single file with `npx playwright test e2e/kanban.spec.ts`.
- One worker, no retries by default (`E2E_RETRIES=n` to allow some). Pages wait for hydration and the dev-server HMR socket is muted so other people's edits cannot reload a page mid-test (`E2E_KEEP_HMR=1` to keep it).
- Output: `test-results/` and `playwright-report/` (`npx playwright show-report`); override with `E2E_OUTPUT_DIR` / `E2E_REPORT_DIR` when several runs share a checkout.
- Layout: `e2e/api.ts` (server URL, seeded accounts, REST client and data factories), `e2e/fixtures.ts` (role fixtures — `test.use({ role: "editor" })`, `api`, `apiAs`, `pageAs`, `loginAs`, `pageWithState` — plus UI/layout helpers), one spec per area of spec §40 (`auth`, `permissions`, `job-create`, `assignment`, `status-flow`, `kanban`, `revisions`, `comments`, `links`, `notifications`, `activity-audit`, `filters-search`, `calendar-timeline`, `dashboard`, `edge-cases`, `mobile`) and `regression-*.spec.ts` for audit regressions.
- Seeded accounts are only ever signed in through their own cookie jars; tests that log out, deactivate or anonymise users invite their own.
