# Proofline

Work management for photography studios. Proofline shows every job, who is working on it, what stage it is at, what is overdue, what each editor is doing, how fast work turns around, every revision and the complete history of every piece of work.

It is **not** a media store. Raw files, editing workspaces and finished galleries stay where they already live (Google Drive, Dropbox, OneDrive, Frame.io, WeTransfer, Lightroom, Pixieset…). Proofline keeps the links and manages the work and the people.

- Product brief: [`docs/PRODUCT-SPEC.md`](docs/PRODUCT-SPEC.md)
- Architecture, data model, permissions, workflow engine, API and page map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (source of truth)
- Roles, permissions, client portal and sharing (roles v2 contract): [`docs/ROLES.md`](docs/ROLES.md)
- REST contract for the UI: [`src/app/api/README.md`](src/app/api/README.md)
- Agent and contributor conventions: [`CLAUDE.md`](CLAUDE.md)

## Features

**Shoot. Give it to an editor. Check it. Done.** Proofline is built around five stages, one list of jobs and one obvious next button (the full product rationale is [`docs/SIMPLIFICATION-PLAN.md`](docs/SIMPLIFICATION-PLAN.md)).

| Area | What you get |
|---|---|
| **Five stages** | Every job is in exactly one stage — **Needs editor · With editor · Ready to check · Changes asked · Done** (plus Cancelled) — and says who it is waiting on ("Waiting on: Sam" / "Waiting on: You"). "Late" is a red chip and a filter, not a stage. The same words appear in lists, buttons, notifications and emails. |
| **Home** | "Good morning, Mo. 3 to check · 2 late · 1 needs an editor." Ready to check (Approve / Ask for changes straight from the card), Needs attention with plain reasons, Your editors, Coming up this week. Editors land on **My jobs**: Changes asked first, then Late, To do, Waiting for a check, Done recently — each card with Raw files and one button. |
| **Jobs** | One list with stage tabs and counts, Late and Show cancelled switches, Search / Editor / Client, and a List / Calendar switch. Same rows everywhere: stage pill, waiting on, due chip ("2 days late", "Due Fri"), Round and Rush badges. |
| **The job page** | One scrolling page: a **Next step** card with at most two buttons for your role and stage (Assign editor · Start editing · Send for checking · Approve / Ask for changes · Reopen · Restore), Files (raw, finished with earlier versions, other), Instructions for the editor, Changes asked rounds, Messages with @mentions, Private notes in their own tinted box, client feedback, and **Who did what** with a link to the full permanent history. Approving a portal client's job asks "Share with …?" every time; owners may approve their own edit after a confirmation. |
| **New job** | One screen, eight fields; the due date defaults to the shoot date plus the shoot type's usual days; "Create & send to Sam" when an editor is picked. Projects are created silently from the address. |
| **Editors** | One page with five plain numbers per editor — On their desk · Late now · Finished · On time · Needed changes — measured from the editor's send, never from your check. "Waiting on you: 4 edits to check" keeps the owner honest. Optional "Usually handles up to N", CSV download, and an editor page with vs-last-month arrows, their desk, recently finished and a finished-per-week chart. |
| **Clients and the portal** | Clients with open and late counts; each client has an **Online access** card (portal on/off, feedback, who can sign in). Client users see Booked → Shot → Editing → Delivered, the shared finished links and a feedback thread. |
| **Front door** | A public landing page at `/`, **Create your studio** (`/signup`: name, email, password, studio name, detected timezone → straight into Home), **invite links** for editors, photographers and clients (`/invite/<token>`, 7 days, single use; copyable from Settings → People or a client's Online access card, emailed when email is set up), **Forgot / Reset password** (`/forgot-password`, `/reset-password?token=…`, 60 minutes) and a **Get set up** checklist on Home for a fresh studio (first job · invite an editor · add a client · give a job to an editor · approve the first edit). |
| **Settings** | One entry: **Studio** (name, timezone, job prefix, the **Advanced tools** switch, Close delivered jobs, the **Email sending** card), **People** (Owner / Photographer / Editor cards, invite with "Only their own shoots" or "Everything (co-owner)", "Can add their own jobs" per editor, deactivate with "Move their jobs to…"), **Types of shoot** (name, colour, usual days to edit), **My account** (8 notification groups on by default, Mark old updates as read, Light / Dark / System), **History** (the studio-wide audit log, each row tagged Sign-in / Job / People / Studio / Client). |
| **Advanced tools (off by default)** | Hidden, not deleted: Board (the five stages as columns, with the Jobs filters; a drop opens the same dialog as the job page's button and anything else snaps back with a plain note), Timeline, Reports & stats, Workloads, custom workflows, Automations, Teams, the full permission table, saved views, bulk actions, projects as a page, time tracking, pause / resume, completion %, four priority levels and extra link / note / message kinds. A studio that already uses custom workflows or automations gets the switch turned on automatically. Hidden pages and APIs are blocked on the server, not just removed from the menu. |
| **Under the hood** | Configurable workflow engine (every status change through one audited service), append-only `activity_events` enforced by DB triggers, optimistic-concurrency conflict dialogs, in-app notifications, ⌘K / Ctrl K search, a mobile layout with a bottom tab bar and a compact pinned next-step bar (the finished-link box opens from it), light and dark themes. |

Roles (contract [`docs/ROLES.md`](docs/ROLES.md); plain summary in the plan §2) — exactly three: **Photographer**, **Editor**, **Client**.

| Persona | Who | Sees | Does |
|---|---|---|---|
| **Owner** (and any co-owner) | a photographer with admin (`users.is_admin`); exactly one is the *primary owner* | everything | creates jobs, gives them to editors, checks edits, approves, manages people and clients |
| **Photographer** (an extra shooter) | other photographers — "Only their own shoots" or "Everything (co-owner)" at invite | only jobs they shot or created | creates jobs for their own shoots, gives them to editors, checks the edits on their own shoots |
| **Editor** | editors | only jobs given to them | edits, sends for checking, fixes changes; "Can add their own jobs" is off unless ticked |
| **Client** | client portal users of one client | only their own shared work, in `/portal` | sees progress and the finished photos, leaves feedback |

Every page, query and service re-checks permissions server-side (ARCHITECTURE §3, ROLES.md §3). Pages a persona may not open return a real `403`; clients are sent to `/portal` and staff away from it. Records that are missing or not shared with the viewer return a `404`, so the response never reveals whether they exist.

## Stack

Next.js 16 (App Router, Turbopack, `proxy.ts`), React 19, TypeScript (strict), Tailwind CSS v4 · Drizzle ORM on Postgres (Supabase in production, PGlite locally) · Zod 4 · jose (signed session cookies) + bcryptjs · lucide-react, @dnd-kit, recharts, cmdk, date-fns · Vitest + Playwright.

## Getting started

Requires Node.js 20+. No database server and no env file are needed locally: dev and tests run on PGlite (Postgres 17 in WASM, in-process, data in `./data/pglite`).

```bash
npm install
npm run db:reset            # fresh ./data/pglite: migrations (incl. integrity triggers), seed the small demo studio, verify
npm run dev                 # http://localhost:3000
```

With no `SESSION_SECRET`, the dev server generates one once into `data/.session-secret` (gitignored). To configure things, `cp .env.example .env`: `SESSION_SECRET` (≥ 32 chars; **required in production**), `PGLITE_DATA_DIR` (default `./data/pglite`), `APP_URL`, and optional `CRON_SECRET` (≥ 32 chars). With `CRON_SECRET` set, a scheduler can call `GET /api/system/cron/sweep` with `Authorization: Bearer <CRON_SECRET>` every few minutes so overdue alerts fire even when nobody has the app open. Never put `DATABASE_URL` in `.env`/`.env.local`: when it is set, the app talks to that Postgres instead of PGlite.

### Demo accounts

The default seed is the **small studio** from the plan (`SEED_PROFILE=small`): one owner who also shoots, one extra photographer, three editors, two clients (one on the portal) and about twenty jobs across every stage, time tracking off. All accounts use the password `Password123!`.

| Account | Shown as | Notes |
|---|---|---|
| `owner@studio.test` | Mo Carter · Owner | Admin and primary owner: creates jobs, gives them to editors, checks and approves |
| `photographer01@studio.test` | Priya Nair · Photographer | "Only their own shoots": creates jobs for her shoots, gives them to editors, checks those edits |
| `editor01@studio.test` | Sam Whitfield · Editor | Usually handles up to 6 jobs |
| `editor02@studio.test` | Ava Mitchell · Editor | No usual capacity set |
| `editor03@studio.test` | Lucas Pham · Editor | Usually handles up to 4 jobs (shown "4 of 4" when full) |
| `client@studio.test` | Sarah Kingsley · Client | Harbourline Realty portal user (shared jobs, delivered links, feedback) — Coastal Key Property has no portal |
| `owner@other.test` | (second studio) | For tenant-isolation checks |

The 160-job, 25-person fixture is still available as `SEED_PROFILE=full` (the full roster is in `src/db/seed/catalog.ts`). Both seeds run the real services under a fake clock, so history, revisions, audit events and the editors' numbers are consistent with each other.

## Getting started for a real studio

The demo accounts are for looking around. A real studio starts from the front door:

1. **Create your studio.** Open `/` and press **Create your studio** (`/signup`): your name, email, a password (10+ characters) and the studio name. The timezone is detected from the browser and can be changed later in Settings → Studio. You land on Home as the owner with a **Get set up** checklist (create a job · invite an editor · add a client · give a job to an editor · approve the first edit); it disappears once the five steps are done, or when you dismiss it.
2. **Invite people by link.** Settings → People → **Invite someone** (editors and extra photographers) or a client's **Online access** card → **Invite someone** (portal users). The default is an **invite link**: copy it from the dialog and send it any way you like; the person opens it, sees who invited them, chooses a password and is in. Links work once and expire after 7 days — the person's page shows **Invite pending · expires …** with **Send a new link** (the old one stops working) and **Revoke invite**. A temporary password is still available as the fallback (**Set a temporary password instead**).
3. **Lost passwords.** Sign in → **Forgot password?** sends a 60-minute reset link. The confirmation never says whether the address has an account.

### Email set-up (optional but recommended)

Without email, every invite and reset link is shown on screen for you to copy (Settings → Studio → **Email sending: not set up** says so; the Studio history records that a link was created, never the link itself). To send them automatically, set these in your hosting environment:

| Variable | Why |
|---|---|
| `APP_URL` | The public origin the links point at, e.g. `https://studio.example.com`. Without it links fall back to the request origin (and `http://localhost:3000` outside a request), so always set it in production. |
| `RESEND_API_KEY` | A [Resend](https://resend.com) API key; invite and reset emails go through Resend. |
| `EMAIL_FROM` | The sender, e.g. `Proofline <hello@studio.example.com>` — a domain verified in Resend. |

Both `RESEND_API_KEY` and `EMAIL_FROM` must be set for sending to turn on; `GET /api/settings/email` (and the Studio card) report `provider: "resend"` when it is.

### Behind a proxy (Vercel and friends)

Sign-up and password-reset rate limits are keyed by client IP. Forwarding headers (`X-Forwarded-For`) are ignored unless you say how many trusted proxies sit in front of the app: on Vercel set `TRUSTED_PROXY_COUNT=1`. With it unset (`0`) the limits fall back to the email address, so a deployment never shares one anonymous bucket — but a single network cannot be slowed down either.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run test` | Vitest unit and integration tests (`src/**/*.test.ts`) |
| `npm run e2e` | Playwright (`e2e/`; starts its own dev server on :3100 with `data/pglite-e2e`, small demo seed) |
| `npm run db:reset` | Dev only (local PGlite; refuses when `DATABASE_URL` is set): delete `./data/pglite`, migrate (schema + guards), seed, verify |
| `npm run db:migrate` · `db:seed` · `db:verify` | Individual steps (`db:seed` refuses to run if data already exists) |
| `npm run db:migrate:remote` · `db:seed:remote [-- --wipe]` · `db:verify:remote` | Supabase maintenance; reads `.env.supabase` (never committed) — see [Supabase](#supabase-production-database) |
| `npm run db:verify` | Recompute every derived job column from the ledgers; must report 0 drift |

After any change to `src/db/schema.ts`, run `npx drizzle-kit generate` (the committed `drizzle/` DDL feeds the test database).

## Architecture in one screen

```
src/app/(public)                  the landing page (own minimal chrome; signed-in people are sent to their landing page)
src/app/(auth)/*                  public forms: login, signup, forgot-password, reset-password, invite/[token]
src/app/(app)/…                   authenticated pages (async Server Components) + loading/error boundaries
src/app/api/**/route.ts           thin REST handlers → one service or query (src/app/api/_lib/route.ts)
src/server/services/*             every write: permission check → Zod → transaction → audit event
src/server/queries/*              read models for pages (org-scoped, visibility-scoped)
src/server/auth/*                 session, passwords, the permission POLICY (can / visibleJobsWhere)
src/server/page.ts                page helpers: pageContext, guard, allowed, load, param(s)
src/components/ui · shell         design-system primitives and the app chrome
src/components/<feature>          feature components (home, jobs-list, job-simple, editors, my-jobs, settings, production, …; the old All Work / My Work / Dashboard / tabbed job page components were deleted)
src/lib/*                         pure helpers, types, constants, validation, dates (org timezone)
src/db/*                          schema, client, guard triggers, seed, verify
```

Conventions that matter when adding a page:

- **Data**: pages are async Server Components that call `pageContext()`, then `guard(ctx, action)`, then `load(() => query(db, ctx, …))`. Interactivity lives in small `"use client"` islands that call the REST API through `src/lib/api-client.ts` and then `router.refresh()`. Filters, sort and tabs live in URL search params.
- **Writes**: send `expectedVersion`. A `409` opens the shared `ConflictDialog`; validation errors map to fields.
- **Real status codes**: a segment's `loading.tsx` starts streaming, after which the status is locked at 200. So permission and existence gates that should return a real 403/404 sit in a `layout.tsx` above the loading boundary (see `jobs/[id]/layout.tsx`, `settings/*/layout.tsx`). List pages whose segment has child routes keep their `page`/`loading`/`error` in a `(list)` route group, so the list skeleton does not wrap the children.
- **Shared UI**: the five-stage visuals (`StagePill`, `StageDot`, `RoundBadge`, `RushBadge`, `WaitingOn`) live in `@/components/jobs/stage-pill`, the plain due chip (`SimpleDueChip`) in `@/components/jobs-list`, and every job action dialog/button (`AssignEditorDialog`, `SendForCheckingDialog`, `ApproveButton`, `AskForChangesDialog`, `ReopenDialog`, …) in `@/components/job-simple`. `SectionCard`/`EmptyState`/`RouteError` are in `@/components/common` and `@/components/ui`. Reuse them rather than writing local copies; the legacy pills in `@/components/jobs` are for Advanced screens only.
- **Navigation**: `src/config/nav.ts` items carry an optional `gate` (`photographer`, `editor`, `admin`, `createJobs`, `newJob`, `advanced`, …) computed server-side by `navGatesFor(ctx)` (`src/server/nav-gates.ts`). Owners see Home · Jobs · Editors · Clients · Settings, extra photographers Home · Jobs · Clients, editors My jobs · Calendar; the Advanced group appears only while Settings → Studio → Advanced tools is on. Hidden pages are blocked server-side (`requireAdvanced` / `redirectUnlessAdvanced`, `src/server/page.ts`) and hidden APIs 404 (`src/app/api/_lib/advanced.ts`). Clients use `portalNavigation` in `src/app/portal`.

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
- `APP_URL` — the public origin for invite / reset links (e.g. `https://studio.example.com`); `RESEND_API_KEY` + `EMAIL_FROM` to email them (otherwise they are shown on screen to copy); `TRUSTED_PROXY_COUNT=1` so the sign-up / reset rate limits see the real client IP behind Vercel's proxy. See [Getting started for a real studio](#getting-started-for-a-real-studio).

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

- Projects: `desktop` (1440×900, every spec except the phone ones) and `mobile` (390×844 touch, `mobile.spec.ts` and `mobile-*.spec.ts`, e.g. `mobile-frontdoor.spec.ts`). Run one with `npm run e2e:desktop` / `npm run e2e:mobile`, or a single file with `npx playwright test e2e/simple-owner-flow.spec.ts`.
- One worker, no retries by default (`E2E_RETRIES=n` to allow some). Pages wait for hydration and the dev-server HMR socket is muted so other people's edits cannot reload a page mid-test (`E2E_KEEP_HMR=1` to keep it).
- Output: `test-results/` and `playwright-report/` (`npx playwright show-report`); override with `E2E_OUTPUT_DIR` / `E2E_REPORT_DIR` when several runs share a checkout.
- Layout: `e2e/api.ts` (server URL, seeded accounts, REST client and data factories built on the simple routes), `e2e/fixtures.ts` (role fixtures — `test.use({ role: "editor" })`, `api`, `apiAs`, `pageAs`, `loginAs`, `pageWithState` — plus UI/layout helpers), the simplified-product specs (`simple-owner-flow`, `simple-editor`, `jobs-page`, `editors-page`, `settings`, `notifications-defaults`, `redirects`, `nav-per-role`, `self-approval`, `advanced`, `mobile`), the front-door specs (`landing`, `signup`, `invite-flow`, `client-invite`, `password-reset`, `onboarding`, `advanced-board`, `mobile-frontdoor` — each creates its own studio or users and never touches the seeded accounts), the kept area specs (`auth`, `permissions`, `assignment`, `revisions`, `comments`, `links`, `activity-audit`, `edge-cases`, `client-portal`, `stacking`) and `regression-*.spec.ts` for audit regressions. Screenshots of the simplified screens live in `docs/screenshots/simple/`, the front door (landing, sign-up, invite, forgot / reset, People invite dialog, Get set up, Studio email card, Board) in `docs/screenshots/front-door/` (desktop 1440×900 and phone 390×844).
- Seeded accounts are only ever signed in through their own cookie jars; tests that log out, deactivate or anonymise users invite their own.
