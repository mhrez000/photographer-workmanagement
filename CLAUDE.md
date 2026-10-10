# Photographer Work Management Platform

Standalone product (NOT part of ListingsReady; the ListingsReady cross-platform rule does not apply here).
Product brief: `docs/PRODUCT-SPEC.md`. Architecture + data model: `docs/ARCHITECTURE.md` (source of truth once written).

## Stack (fixed — do not swap libraries)
- Next.js 16.4 App Router (`src/app`), React 19, TypeScript strict, Tailwind CSS v4 (`src/app/globals.css` holds design tokens).
- Drizzle ORM on **Postgres** (ASYNC everywhere): production = Supabase via `postgres` (postgres-js, `DATABASE_URL`); local dev/tests/e2e = PGlite (in-process Postgres, `PGLITE_DATA_DIR`, default `./data/pglite`). Schema `src/db/schema.ts` (pg-core); client `src/db/index.ts`; migrations `drizzle/` (integrity triggers in `drizzle/0001_guards.sql`). Conversion rules: `docs/POSTGRES-MIGRATION.md`.
- Zod 4 for validation (`import { z } from "zod"`), jose for signed session cookies, bcryptjs for passwords.
- UI: lucide-react icons, @dnd-kit (kanban), recharts (charts), cmdk (command palette), date-fns (dates), `cn()` from `src/lib/utils.ts`.
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
- Env: local dev needs none (`npm install` → `npm run db:reset` → `npm run dev`; without `SESSION_SECRET` the dev server generates `data/.session-secret`). Optional `.env`: `SESSION_SECRET` (≥ 32 chars, REQUIRED in production), `PGLITE_DATA_DIR`, `CRON_SECRET`; see `.env.example`. Supabase URLs (`DATABASE_URL` = transaction pooler :6543, `DIRECT_URL` = session pooler :5432) live ONLY in `.env.supabase` (gitignored, not loaded by Next; never print them) and in Vercel env vars. Never put `DATABASE_URL` in `.env`/`.env.local`.
- Remote (Supabase): `db:migrate:remote` (schema + guards, idempotent) → `db:seed:remote` (refuses a non-empty target; `-- --wipe` REPLACES all remote data) → `db:verify:remote` (0 drift). Production-mode check: `npx next build` then `node scripts/start-remote.mjs 3160`. `REMOTE_ENV_FILE=<file>` retargets all of these (e.g. a local Postgres rehearsal). Remote writes need the user's explicit go-ahead.

Roles (v2, contract `docs/ROLES.md`): exactly three roles — `photographer`, `editor`, `client`. Admin is `users.is_admin` on a photographer (persona "Owner / Photographer"); other photographers are team members with permission switches. There are no owner/manager roles.

Demo login (seeded, all `Password123!`): `owner@studio.test` (Owner / Photographer, admin, primary owner; also shoots); `photographer01@studio.test` (team member: sees all jobs, workloads & analytics); `photographer02..11@studio.test` (team members: own jobs, review their own shoots); `photographer12@studio.test` (junior: the owner assigns and reviews her work); `editor01..13@studio.test` (editor02 sees other editors' jobs; editor09 cannot create jobs; editor11 and editor13 are deactivated); client portal users `client@studio.test` (Harbourline Realty) and `client2@studio.test` (Coastal Key Property, nothing shared). Second org for isolation tests: `owner@other.test`, `editor@other.test`, `client@other.test`. Full roster in `src/db/seed/catalog.ts`.

## Page conventions (UI integration pass)
- Pages: `const { ctx, db } = await pageContext(); guard(ctx, "<action>"); const x = await load(() => query(db, ctx, …))` (`src/server/page.ts`). Client islands call `api` from `src/lib/api-client.ts` then `router.refresh()`; URL search params hold filter/sort/tab state.
- **Real 403/404 status**: once a segment's `loading.tsx` streams, the status is locked at 200. Put permission/existence gates that must return a real 403/404 in a `layout.tsx` ABOVE the loading boundary (e.g. `settings/organisation/layout.tsx`, `jobs/[id]/layout.tsx`). A segment with child routes keeps its own `page`/`loading`/`error` in a `(list)` (or `(detail)`) route group so its skeleton does not wrap the children. `(app)/forbidden.tsx` and `(app)/not-found.tsx` render inside the app shell.
- Shared display/actions live in `@/components/jobs` (StatusPill, PriorityPill, DueChip, PersonChip, WorkloadBand, CapacityBar, JobActionBar, ConflictDialog…), `@/components/common` (SectionCard, StatTile, ConfirmDialog, RouteError), `@/components/filters`. Do not write local copies.
- Nav visibility: `src/config/nav.ts` items take an optional `gate` (`admin` / `createJobs` / `createClients` / `teamWork` / `directory` / `teamWorkloads` / `analytics`); `navGatesFor(ctx)` (`src/server/nav-gates.ts`) computes them with `can()` in `src/app/(app)/layout.tsx`. Clients use the portal (`src/app/portal`, `portalNavigation`) and never the staff shell.
- Permission refs for jobs: always `loadJobRef` / `loadJobRefs` (`src/server/auth/job-ref.ts`), never a hand-built `JobPermissionRef` (the draft window, past editors and project sharing would be wrong). Person pages (`/team/users/[id]`) use `canOpenPersonPage` (`queries/workloads.ts`), not `user.view` alone.
- Layering: use the z-index tokens in `globals.css` (`z-(--z-page-sticky)` 20 · `--z-shell` 30 · `--z-topbar` 40 · `--z-popover` 50 · `--z-toast` 100). No page element may reach `--z-topbar`; tooltips inside the fixed sidebar portal to `document.body` (ROLES.md §11.1, `e2e/stacking.spec.ts`).
- Shell client components render on statically prerendered pages too (`/design-system`): don't call `useSearchParams()` in them without a Suspense boundary (read `window.location` inside event handlers instead) or `next build` fails.
- Next 16 allows ONE `next dev` per checkout (a second one exits with "Another next dev server is already running"). To run a second server, `next build` then `next start -p <port>`.
- Theme/density boot script is mounted once in the root layout (`AppearanceBoot`, next/script `beforeInteractive`).

## Working agreements for agents
- Stay inside the files/areas you were assigned. Shared files (`schema.ts`, `types.ts`, `permissions.ts`, nav config, `components/ui/*`) are owned by the foundation; if you must change one, keep it minimal and additive and say so in your report.
- Run `npm run typecheck` (and `npm run lint` on your files) before reporting done. Report real results, not assumptions.
- Prefer server components + small client islands. No `any`. No `console.log` left behind.
- Every list/table page needs: loading state (`loading.tsx` or Skeleton), empty state, error boundary (`error.tsx`).
