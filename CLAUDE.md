# Photographer Work Management Platform

Standalone product (NOT part of ListingsReady; the ListingsReady cross-platform rule does not apply here).
Product brief: `docs/PRODUCT-SPEC.md`. Architecture + data model: `docs/ARCHITECTURE.md` (source of truth once written).

## Stack (fixed — do not swap libraries)
- Next.js 16.4 App Router (`src/app`), React 19, TypeScript strict, Tailwind CSS v4 (`src/app/globals.css` holds design tokens).
- Drizzle ORM + better-sqlite3. DB file `data/app.db`. Schema in `src/db/schema.ts`; client in `src/db/index.ts`.
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
`npm run dev` · `npm run build` · `npm run typecheck` · `npm run lint` · `npm run test` · `npm run db:push` · `npm run db:guard` · `npm run db:seed` · `npm run db:reset` · `npm run db:verify` · `npm run e2e`

- `db:reset` (dev only) = delete `data/app.db*` → `db:push` → `db:guard` (28 integrity triggers) → `db:seed` (real services under a fake clock, ~15 s; exits 1 on drift or a missed §39 minimum). `db:seed` refuses to run when organisations already exist.
- `db:verify` recomputes every derived job column from the ledgers (same check as `GET /api/system/integrity`); must report 0 drift.
- After any `schema.ts` change run `npx drizzle-kit generate` (the committed `drizzle/` DDL feeds `makeTestDb()`).
- Env: `.env` needs `SESSION_SECRET` (≥ 32 chars) and optional `DATABASE_PATH` (default `./data/app.db`); see `.env.example`.

Demo login (seeded, all `Password123!`): owner `owner@studio.test`; managers `manager1@`/`manager2@studio.test`; `photographer01..12@studio.test` (photographer01 has team-workload + analytics flags); `editor01..13@studio.test` (editor11 and editor13 are deactivated). Second org for isolation tests: `owner@other.test`. Full roster in `src/db/seed/catalog.ts`.

## Page conventions (UI integration pass)
- Pages: `const { ctx, db } = await pageContext(); guard(ctx, "<action>"); const x = load(() => query(db, ctx, …))` (`src/server/page.ts`). Client islands call `api` from `src/lib/api-client.ts` then `router.refresh()`; URL search params hold filter/sort/tab state.
- **Real 403/404 status**: once a segment's `loading.tsx` streams, the status is locked at 200. Put permission/existence gates that must return a real 403/404 in a `layout.tsx` ABOVE the loading boundary (e.g. `settings/organisation/layout.tsx`, `jobs/[id]/layout.tsx`). A segment with child routes keeps its own `page`/`loading`/`error` in a `(list)` (or `(detail)`) route group so its skeleton does not wrap the children. `(app)/forbidden.tsx` and `(app)/not-found.tsx` render inside the app shell.
- Shared display/actions live in `@/components/jobs` (StatusPill, PriorityPill, DueChip, PersonChip, WorkloadBand, CapacityBar, JobActionBar, ConflictDialog…), `@/components/common` (SectionCard, StatTile, ConfirmDialog, RouteError), `@/components/filters`. Do not write local copies.
- Nav visibility: `src/config/nav.ts` items take `roles` plus an optional `grant` (`analytics` / `teamWorkloads` / `teamWork`) computed with `can()` in `src/app/(app)/layout.tsx`, so flag-based access (e.g. photographer analytics) shows in the sidebar and palette.
- Theme/density boot script is mounted once in the root layout (`AppearanceBoot`, next/script `beforeInteractive`).

## Working agreements for agents
- Stay inside the files/areas you were assigned. Shared files (`schema.ts`, `types.ts`, `permissions.ts`, nav config, `components/ui/*`) are owned by the foundation; if you must change one, keep it minimal and additive and say so in your report.
- Run `npm run typecheck` (and `npm run lint` on your files) before reporting done. Report real results, not assumptions.
- Prefer server components + small client islands. No `any`. No `console.log` left behind.
- Every list/table page needs: loading state (`loading.tsx` or Skeleton), empty state, error boundary (`error.tsx`).
