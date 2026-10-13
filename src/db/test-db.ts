/**
 * Test database + fixtures (ARCHITECTURE.md §13). Used by every vitest file
 * that touches the DB; never imported by app code. Everything is async.
 *
 *   const db = await makeTestDb();               // fresh in-memory PGlite: schema + guard triggers
 *   const ids = await seedMinimalOrg(db);        // org, settings, 10 users (roles v2 personas), default workflow, job types, 2 clients, 2 projects
 *   const job = await insertJobFixture(db, ids, { statusKey: "in_progress" });
 *   const ctx = await contextFor(db, ids.users.editor1);
 *   await withTx((tx) => someService(tx, ctx, input), { db });
 *   await verifyDerived(db)                      // zero drift on fixtures
 *
 * makeTestDb() clones a per-worker template: the first call creates an
 * in-memory PGlite, applies the committed ./drizzle migrations (schema +
 * drizzle/0001_guards.sql) and dumps its data dir; every call then boots a
 * new PGlite from that dump (~0.2–0.4 s). Instances are closed automatically
 * after each test by src/db/test-setup.ts (vitest setupFiles) — create test
 * databases in `beforeEach` or inside the test, never at describe level or
 * in `beforeAll`.
 *
 * The returned handle is root-guarded (src/db/index.ts guardRootDb): calling
 * `db.select()` etc. on it from inside a transaction callback throws
 * RootDbInTransactionError instead of deadlocking PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { hashSync } from "bcryptjs";
import * as schema from "./schema";
import { guardRootDb, migratePgliteClient, PGLITE_PARSERS, type Db, type DbLike } from "./index";
import { rootErrorMessage } from "./errors";
import {
  CANCEL_EDGE_ROLES,
  CATEGORY_GROUPS,
  DEFAULT_JOB_NUMBER_PREFIX,
  DEFAULT_JOB_TYPES,
  DEFAULT_OFF_NOTIFICATION_TYPES,
  DEFAULT_TIMEZONE,
  DEFAULT_WORKFLOW_NAME,
  DEFAULT_WORKFLOW_STATUSES,
  DEFAULT_WORKFLOW_TRANSITIONS,
  JOB_NUMBER_PAD,
  MEMBER_INVITE_DEFAULTS,
  STATUS_CATEGORY_META,
  type NotificationType,
  type PermissionFlag,
  type Priority,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, Job, NewOrganisationSettings } from "@/lib/types";
import { advanceClock, nowIso, resetClock, setClock } from "@/server/clock";
import { buildContextFromDb, systemContext, type BuildContextOptions } from "@/server/auth/session";
import { recordEvent } from "@/server/audit";

/* ------------------------------------------------------------------ */
/*  makeTestDb                                                         */
/* ------------------------------------------------------------------ */

/** A root-guarded Drizzle handle over its own in-memory PGlite (`$client`). */
export type TestDb = Db & { $client: PGlite };

let templateDump: Promise<File | Blob> | null = null;

/** Migrated empty database, dumped once per vitest worker. */
function template(): Promise<File | Blob> {
  templateDump ??= (async () => {
    const client = await PGlite.create({ parsers: PGLITE_PARSERS });
    try {
      await migratePgliteClient(client);
      return await client.dumpDataDir("none");
    } finally {
      await client.close();
    }
  })();
  templateDump.catch(() => {
    templateDump = null;
  });
  return templateDump;
}

const openClients = new Set<PGlite>();

/** Fresh, isolated in-memory database with the full schema and every guard trigger. */
export async function makeTestDb(): Promise<TestDb> {
  const client = await PGlite.create({ loadDataDir: await template(), parsers: PGLITE_PARSERS });
  openClients.add(client);
  const db = drizzle(client, { schema }) as unknown as TestDb;
  return guardRootDb(db);
}

/** Closes every test database opened so far (called after each test by src/db/test-setup.ts). */
export async function closeTestDbs(): Promise<void> {
  const clients = Array.from(openClients);
  openClients.clear();
  await Promise.all(clients.map((c) => (c.closed ? Promise.resolve() : c.close().catch(() => undefined))));
}

/**
 * Awaits a promise that must reject with a DB error and returns the Postgres
 * message (Drizzle wraps it as "Failed query: …", see src/db/errors.ts).
 *
 *   expect(await dbRejection(db.update(notifications).set({ title: "x" }))).toMatch(/read_at/);
 */
export async function dbRejection(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return rootErrorMessage(err);
  }
  throw new Error("dbRejection: expected the query to be rejected, but it succeeded");
}

/* ------------------------------------------------------------------ */
/*  Clock helpers                                                      */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;

/** Thin wrapper over src/server/clock.ts for tests (always `reset()` in afterEach). */
export const fakeClock = {
  /** Freeze the clock at an ISO instant (default 2026-10-08T00:00:00.000Z = 11:00 Sydney). */
  set(iso: string = "2026-10-08T00:00:00.000Z"): string {
    setClock(iso);
    return nowIso();
  },
  advanceMs(ms: number): string {
    advanceClock(ms);
    return nowIso();
  },
  advanceMinutes(minutes: number): string {
    return fakeClock.advanceMs(minutes * MINUTE);
  },
  advanceHours(hours: number): string {
    return fakeClock.advanceMs(hours * 60 * MINUTE);
  },
  advanceDays(days: number): string {
    return fakeClock.advanceMs(days * 24 * 60 * MINUTE);
  },
  now(): string {
    return nowIso();
  },
  reset(): void {
    resetClock();
  },
};

/* ------------------------------------------------------------------ */
/*  seedMinimalOrg                                                     */
/* ------------------------------------------------------------------ */

export const TEST_PASSWORD = "Password123!";

let cachedHash: string | null = null;
/** bcrypt hash of TEST_PASSWORD at cost 4 (fast; bcrypt verifies any cost). */
export function testPasswordHash(): string {
  cachedHash ??= hashSync(TEST_PASSWORD, 4);
  return cachedHash;
}

/**
 * Roles v2 fixture personas (docs/ROLES.md §12.1):
 *   owner          primary owner (admin photographer)
 *   coAdmin        second admin photographer (ported from v1 tests that used `manager` as "another management user")
 *   lead           team member with every switch on (= a migrated v1 manager)
 *   photographer1/2 team members with the MIGRATED defaults (create ✓, assign ✓, review ✓; workloads/all/analytics ✗)
 *   editor1/2      editors at defaults (create ✓, see other editors' jobs ✗)
 *   inactiveEditor deactivated editor
 *   client         client user of `clientId` (portal ✓, feedback ✓)
 *   client2        client user of `clientId2` (portal ✓, feedback ✗) — isolation
 * Use `setUserFlags()` / `inviteDefaultsMember()` for other switch combinations.
 */
export type FixtureUserKey =
  | "owner"
  | "coAdmin"
  | "lead"
  | "photographer1"
  | "photographer2"
  | "editor1"
  | "editor2"
  | "inactiveEditor"
  | "client"
  | "client2";

/** Raw users.* switch columns (camelCase = AuthContext field names). */
export type FixtureFlags = Partial<Record<PermissionFlag, boolean>>;

interface FixtureUserDef {
  key: FixtureUserKey;
  local: string;
  name: string;
  role: Role;
  active: boolean;
  colour: string;
  isAdmin?: boolean;
  flags?: FixtureFlags;
  /** Client users: which fixture client. */
  client?: "client" | "client2";
}

const ALL_MEMBER_FLAGS_ON: FixtureFlags = {
  canCreateJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: true,
  canViewAllJobs: true,
  canViewAnalytics: true,
};

const FIXTURE_USERS: readonly FixtureUserDef[] = [
  { key: "owner", local: "owner", name: "Olivia Owner", role: "photographer", isAdmin: true, active: true, colour: "#6366f1" },
  { key: "coAdmin", local: "coadmin", name: "Cora Co-Admin", role: "photographer", isAdmin: true, active: true, colour: "#0ea5e9" },
  { key: "lead", local: "lead", name: "Leo Lead", role: "photographer", active: true, colour: "#8b5cf6", flags: ALL_MEMBER_FLAGS_ON },
  { key: "photographer1", local: "photographer01", name: "Pia Photographer", role: "photographer", active: true, colour: "#14b8a6" },
  { key: "photographer2", local: "photographer02", name: "Paul Photographer", role: "photographer", active: true, colour: "#22c55e" },
  { key: "editor1", local: "editor01", name: "Eve Editor", role: "editor", active: true, colour: "#f59e0b" },
  { key: "editor2", local: "editor02", name: "Ed Editor", role: "editor", active: true, colour: "#f97316" },
  { key: "inactiveEditor", local: "editor99", name: "Iris Inactive", role: "editor", active: false, colour: "#64748b" },
  { key: "client", local: "client", name: "Cleo Client", role: "client", active: true, colour: "#d97706", client: "client" },
  { key: "client2", local: "client2", name: "Clay Client", role: "client", active: true, colour: "#0891b2", client: "client2" },
];

export interface SeedMinimalOrgOptions {
  /** Organisation slug; also the id prefix (default "studio"). */
  slug?: string;
  name?: string;
  /** Email domain (default `<slug>.test`, i.e. "studio.test"). Must differ per org (emails are globally unique). */
  emailDomain?: string;
  /** organisation_settings overrides. */
  settings?: Partial<Omit<NewOrganisationSettings, "organisationId">>;
  /** Timestamp for created_at columns (default: the clock). */
  at?: string;
}

export interface SeedIds {
  organisationId: string;
  slug: string;
  users: Record<FixtureUserKey, string>;
  emails: Record<FixtureUserKey, string>;
  password: string;
  workflowId: string;
  /** status key → id (default workflow). */
  statuses: Record<string, string>;
  /** `${fromKey}->${toKey}` → workflow_transitions.id (includes generated `->cancelled` edges). */
  transitions: Record<string, string>;
  /** job type name → id. */
  jobTypes: Record<string, string>;
  defaultJobTypeId: string;
  /** "Harbour Realty": portal ✓, feedback ✓; client user `client`. */
  clientId: string;
  projectId: string;
  /** "Coastal Key Property": portal ✓, feedback ✗; client user `client2`. */
  clientId2: string;
  projectId2: string;
}

/**
 * Inserts the default workflow (DEFAULT_WORKFLOW_STATUSES / _TRANSITIONS
 * plus a generated `→ cancelled` edge for every active status).
 */
export async function insertDefaultWorkflow(
  db: DbLike,
  organisationId: string,
  opts: { createdByUserId?: string | null; at?: string; idPrefix?: string; name?: string; isDefault?: boolean } = {},
): Promise<{ workflowId: string; statuses: Record<string, string>; transitions: Record<string, string> }> {
  const at = opts.at ?? nowIso();
  const prefix = opts.idPrefix ?? organisationId;
  const workflowId = `${prefix}-wf`;
  await db.insert(schema.workflows).values({
    id: workflowId,
    organisationId,
    name: opts.name ?? DEFAULT_WORKFLOW_NAME,
    isDefault: opts.isDefault ?? true,
    createdByUserId: opts.createdByUserId ?? null,
    createdAt: at,
    updatedAt: at,
  });

  const statuses: Record<string, string> = {};
  const statusRows = DEFAULT_WORKFLOW_STATUSES.map((s) => {
    const id = `${prefix}-st-${s.key}`;
    statuses[s.key] = id;
    return {
      id,
      organisationId,
      workflowId,
      key: s.key,
      name: s.name,
      category: s.category,
      colour: s.colour,
      sortOrder: s.sortOrder,
      isInitial: s.isInitial,
      createdAt: at,
      updatedAt: at,
    };
  });
  await db.insert(schema.workflowStatuses).values(statusRows);

  const transitions: Record<string, string> = {};
  const edges = [
    ...DEFAULT_WORKFLOW_TRANSITIONS.map((t) => ({ ...t })),
    ...DEFAULT_WORKFLOW_STATUSES.filter((s) => STATUS_CATEGORY_META[s.category].open).map((s) => ({
      from: s.key,
      to: "cancelled",
      label: "Cancel",
      allowedRoles: CANCEL_EDGE_ROLES,
      requiresAssignedEditor: false,
      assigneeOnly: false,
      isReopen: false,
    })),
  ];
  const transitionRows = edges.map((e) => {
    const id = `${prefix}-tr-${e.from}-${e.to}`;
    transitions[`${e.from}->${e.to}`] = id;
    return {
      id,
      organisationId,
      workflowId,
      fromStatusId: statuses[e.from],
      toStatusId: statuses[e.to],
      label: e.label,
      allowedRoles: [...e.allowedRoles],
      requiresAssignedEditor: e.requiresAssignedEditor ?? false,
      assigneeOnly: e.assigneeOnly ?? false,
      isReopen: e.isReopen ?? false,
      createdAt: at,
      updatedAt: at,
    };
  });
  await db.insert(schema.workflowTransitions).values(transitionRows);
  return { workflowId, statuses, transitions };
}

/**
 * One organisation with known ids/emails (`<slug>-owner`, `owner@<domain>` …):
 * the ten roles-v2 personas of `FixtureUserKey` (all with password
 * TEST_PASSWORD; `owner` is the primary owner), settings, the default
 * workflow, DEFAULT_JOB_TYPES, two portal-enabled clients with one project
 * each and one client user each. Insert order is trigger-safe: org → settings
 * (no primary owner yet) → staff → clients/projects → client users → primary
 * owner. Call twice with different slugs for cross-organisation tests.
 */
export async function seedMinimalOrg(db: Db, overrides: SeedMinimalOrgOptions = {}): Promise<SeedIds> {
  const slug = overrides.slug ?? "studio";
  const domain = overrides.emailDomain ?? `${slug}.test`;
  const at = overrides.at ?? nowIso();
  const organisationId = `${slug}-org`;
  const hash = testPasswordHash();

  return db.transaction(async (tx) => {
    await tx
      .insert(schema.organisations)
      .values({ id: organisationId, name: overrides.name ?? `${slug[0].toUpperCase()}${slug.slice(1)} Studio`, slug, createdAt: at, updatedAt: at });
    await tx
      .insert(schema.organisationSettings)
      .values({ timezone: DEFAULT_TIMEZONE, jobNumberPrefix: DEFAULT_JOB_NUMBER_PREFIX, ...overrides.settings, organisationId, updatedAt: at });

    const users = {} as Record<FixtureUserKey, string>;
    const emails = {} as Record<FixtureUserKey, string>;
    const clientId = `${slug}-client`;
    const clientId2 = `${slug}-client2`;
    const userRow = (u: FixtureUserDef) => {
      const id = `${slug}-${u.key}`;
      const email = `${u.local}@${domain}`;
      users[u.key] = id;
      emails[u.key] = email;
      return {
        id,
        organisationId,
        email,
        passwordHash: hash,
        name: u.name,
        role: u.role,
        isAdmin: u.isAdmin ?? false,
        ...u.flags,
        clientId: u.client === "client" ? clientId : u.client === "client2" ? clientId2 : null,
        isActive: u.active,
        deactivatedAt: u.active ? null : at,
        avatarColour: u.colour,
        createdAt: at,
        updatedAt: at,
      };
    };
    await tx.insert(schema.users).values(FIXTURE_USERS.filter((u) => u.role !== "client").map(userRow));

    const wf = await insertDefaultWorkflow(tx, organisationId, { createdByUserId: users.owner, at, idPrefix: slug });

    const jobTypes: Record<string, string> = {};
    const jobTypeRows = DEFAULT_JOB_TYPES.map((jt, i) => {
      const id = `${slug}-jt-${i}`;
      jobTypes[jt.name] = id;
      return {
        id,
        organisationId,
        name: jt.name,
        colour: jt.colour,
        workflowId: wf.workflowId,
        defaultEstimatedHours: jt.defaultEstimatedHours,
        sortOrder: i,
        createdAt: at,
        updatedAt: at,
      };
    });
    await tx.insert(schema.jobTypes).values(jobTypeRows);

    await tx.insert(schema.clients).values([
      {
        id: clientId,
        organisationId,
        name: "Harbour Realty",
        portalEnabled: true,
        feedbackEnabled: true,
        createdByUserId: users.owner,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: clientId2,
        organisationId,
        name: "Coastal Key Property",
        portalEnabled: true,
        feedbackEnabled: false,
        createdByUserId: users.owner,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    const projectId = `${slug}-project`;
    const projectId2 = `${slug}-project2`;
    await tx.insert(schema.projects).values([
      {
        id: projectId,
        organisationId,
        clientId,
        name: "123 Smith Street",
        address: "123 Smith Street, Bondi NSW",
        createdByUserId: users.owner,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: projectId2,
        organisationId,
        clientId: clientId2,
        name: "9 Beach Road",
        address: "9 Beach Road, Coogee NSW",
        createdByUserId: users.owner,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    await tx.insert(schema.users).values(FIXTURE_USERS.filter((u) => u.role === "client").map(userRow));
    await tx
      .update(schema.organisationSettings)
      .set({ primaryOwnerUserId: users.owner })
      .where(eq(schema.organisationSettings.organisationId, organisationId));

    return {
      organisationId,
      slug,
      users,
      emails,
      password: TEST_PASSWORD,
      workflowId: wf.workflowId,
      statuses: wf.statuses,
      transitions: wf.transitions,
      jobTypes,
      defaultJobTypeId: jobTypes[DEFAULT_JOB_TYPES[0].name],
      clientId,
      projectId,
      clientId2,
      projectId2,
    };
  });
}

/**
 * Opts every fixture staff user in to the notification types that are OFF by default since the
 * simplified UI (SIMPLIFICATION-PLAN §8: `NOTIFICATION_TYPE_META.defaultOn`), by inserting explicit
 * `enabled = true` preference rows — the way a person does it under My account → Notifications.
 * Tests of the older per-type notices (deadline_changed, job_declined, review_overdue, automation, …)
 * call it after `seedMinimalOrg`; tests of the new defaults do not.
 */
export async function optInAllNotifications(db: DbLike, ids: SeedIds, types: readonly NotificationType[] = DEFAULT_OFF_NOTIFICATION_TYPES): Promise<void> {
  const staff = (Object.keys(ids.users) as FixtureUserKey[]).filter((k) => k !== "client" && k !== "client2").map((k) => ids.users[k]);
  const at = nowIso();
  const rows = staff.flatMap((userId) => types.map((type) => ({ organisationId: ids.organisationId, userId, type, enabled: true, updatedAt: at })));
  if (rows.length === 0) return;
  await db.insert(schema.userNotificationPrefs).values(rows).onConflictDoNothing();
}

/**
 * Sets raw users.* switch columns (and optionally is_admin) directly — fixtures
 * only; production writes go through `setPermissions` / `setAdmin`. Bumps version.
 */
export async function setUserFlags(db: DbLike, userId: string, flags: FixtureFlags & { isAdmin?: boolean }): Promise<void> {
  await db
    .update(schema.users)
    .set({ ...flags, version: sql`${schema.users.version} + 1` })
    .where(eq(schema.users.id, userId));
}

/**
 * Adds a team member at the INVITE defaults (create ✓, assign ✓, review ✗,
 * workloads / all jobs / analytics ✗): "photographer12-style" (the owner reviews
 * their work). Returns the new user id (`<slug>-newMember`, `new.member@<domain>`).
 */
export async function inviteDefaultsMember(
  db: DbLike,
  ids: SeedIds,
  opts: { key?: string; name?: string; email?: string; at?: string } = {},
): Promise<string> {
  const key = opts.key ?? "newMember";
  const id = `${ids.slug}-${key}`;
  const at = opts.at ?? nowIso();
  const domain = ids.emails.owner.split("@")[1];
  await db.insert(schema.users).values({
    id,
    organisationId: ids.organisationId,
    email: opts.email ?? `${key.toLowerCase()}@${domain}`,
    passwordHash: testPasswordHash(),
    name: opts.name ?? "Nina Newmember",
    role: "photographer",
    isAdmin: false,
    ...MEMBER_INVITE_DEFAULTS,
    avatarColour: "#ec4899",
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

/* ------------------------------------------------------------------ */
/*  Teams                                                              */
/* ------------------------------------------------------------------ */

/** Adds a team with active memberships (opt-in: teams change visibility). */
export async function addTeamFixture(
  db: Db,
  ids: SeedIds,
  opts: { name?: string; memberIds: string[]; archived?: boolean; leadUserId?: string | null; at?: string },
): Promise<{ teamId: string; membershipIds: string[] }> {
  const at = opts.at ?? nowIso();
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(schema.teams)
      .values({
        organisationId: ids.organisationId,
        name: opts.name ?? `Team ${Math.random().toString(36).slice(2, 7)}`,
        leadUserId: opts.leadUserId ?? null,
        archivedAt: opts.archived ? at : null,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: schema.teams.id });
    const membershipIds: string[] = [];
    for (const userId of opts.memberIds) {
      const [row] = await tx
        .insert(schema.teamMemberships)
        .values({ organisationId: ids.organisationId, teamId: team.id, userId, addedByUserId: ids.users.owner, joinedAt: at })
        .returning({ id: schema.teamMemberships.id });
      membershipIds.push(row.id);
    }
    return { teamId: team.id, membershipIds };
  });
}

/* ------------------------------------------------------------------ */
/*  insertJobFixture                                                   */
/* ------------------------------------------------------------------ */

export interface JobFixtureOptions {
  /** Default-workflow status key (default "new"). */
  statusKey?: string;
  /** null = no editor. Default: editor1 for editor/reviewer-held and done categories, none for new/ready/cancelled. */
  editorId?: string | null;
  /** null = no photographer. Default: photographer1. */
  photographerId?: string | null;
  createdByUserId?: string;
  /** jobs.created_by_role. Default: "editor" when the creator is an editor, else "photographer". */
  createdByRole?: "photographer" | "editor";
  /** jobs.shared_with_client (default false). */
  sharedWithClient?: boolean;
  name?: string;
  description?: string | null;
  priority?: Priority;
  dueDate?: string | null;
  shootDate?: string | null;
  reviewDueDate?: string | null;
  deliveryDueDate?: string | null;
  estimatedHours?: number | null;
  isPaused?: boolean;
  projectId?: string;
  jobTypeId?: string;
  /** created_at / entered_at (default: the clock). */
  at?: string;
}

export interface JobFixture {
  job: Job;
  transitionId: string;
  eventId: string;
  assignmentIds: { photographer: string | null; editor: string | null };
}

const NEEDS_EDITOR: ReadonlySet<StatusCategory> = new Set<StatusCategory>([
  ...CATEGORY_GROUPS.EDITOR_HOLDS,
  ...CATEGORY_GROUPS.REVIEWER_HOLDS,
  "approved",
  "delivered",
  "completed",
]);

const AFTER_START: ReadonlySet<StatusCategory> = new Set<StatusCategory>([
  "in_progress", "submitted", "review", "revision", "resubmitted", "approved", "delivered", "completed",
]);
const AFTER_SUBMIT: ReadonlySet<StatusCategory> = new Set<StatusCategory>([
  "submitted", "review", "revision", "resubmitted", "approved", "delivered", "completed",
]);
const APPROVED_LIKE: ReadonlySet<StatusCategory> = new Set<StatusCategory>(["approved", "delivered", "completed"]);

/**
 * Inserts a job directly in `statusKey` (one `creation` transition row into
 * that status — no fabricated history), its open assignment rows and a
 * `job.created` event, in the trigger-safe order: job → transition →
 * assignments → event. The result passes `verifyDerived()` with zero drift.
 * Use the real services when a test needs a multi-step history.
 */
export async function insertJobFixture(db: Db, ids: SeedIds, opts: JobFixtureOptions = {}): Promise<JobFixture> {
  const at = opts.at ?? nowIso();
  const statusKey = opts.statusKey ?? "new";
  const statusId = ids.statuses[statusKey];
  if (!statusId) throw new Error(`insertJobFixture: unknown status key "${statusKey}"`);

  return db.transaction(async (tx) => {
    const [status] = await tx.select().from(schema.workflowStatuses).where(eq(schema.workflowStatuses.id, statusId));
    if (!status) throw new Error(`insertJobFixture: status ${statusId} missing`);
    const category = status.category;
    const editorId = opts.editorId !== undefined ? opts.editorId : NEEDS_EDITOR.has(category) ? ids.users.editor1 : null;
    const photographerId = opts.photographerId !== undefined ? opts.photographerId : ids.users.photographer1;
    const createdByUserId = opts.createdByUserId ?? ids.users.photographer1;
    const [creator] = await tx.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, createdByUserId));
    const createdByRole = opts.createdByRole ?? (creator?.role === "editor" ? "editor" : "photographer");

    const [seq] = await tx
      .update(schema.organisations)
      .set({ jobSequence: sql`${schema.organisations.jobSequence} + 1` })
      .where(eq(schema.organisations.id, ids.organisationId))
      .returning({ n: schema.organisations.jobSequence });
    const [settings] = await tx
      .select({ prefix: schema.organisationSettings.jobNumberPrefix })
      .from(schema.organisationSettings)
      .where(eq(schema.organisationSettings.organisationId, ids.organisationId));
    const jobNumber = `${settings?.prefix ?? DEFAULT_JOB_NUMBER_PREFIX}-${String(seq.n).padStart(JOB_NUMBER_PAD, "0")}`;

    const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, opts.projectId ?? ids.projectId));
    if (!project) throw new Error("insertJobFixture: project missing");

    const [job] = await tx
      .insert(schema.jobs)
      .values({
        organisationId: ids.organisationId,
        jobNumber,
        name: opts.name ?? `Job ${jobNumber}`,
        description: opts.description ?? null,
        clientId: project.clientId,
        projectId: project.id,
        jobTypeId: opts.jobTypeId ?? ids.defaultJobTypeId,
        workflowId: status.workflowId,
        priority: opts.priority ?? "normal",
        statusId,
        statusCategory: category,
        previousStatusId: null,
        statusEnteredAt: at,
        photographerId,
        editorId,
        shootDate: opts.shootDate ?? null,
        dueDate: opts.dueDate ?? null,
        reviewDueDate: opts.reviewDueDate ?? null,
        deliveryDueDate: opts.deliveryDueDate ?? null,
        estimatedHours: opts.estimatedHours ?? null,
        completionPercent: APPROVED_LIKE.has(category) ? 100 : AFTER_SUBMIT.has(category) ? 90 : 0,
        isPaused: opts.isPaused ?? false,
        pausedAt: opts.isPaused ? at : null,
        startedAt: AFTER_START.has(category) ? at : null,
        firstSubmittedAt: AFTER_SUBMIT.has(category) ? at : null,
        lastSubmittedAt: AFTER_SUBMIT.has(category) ? at : null,
        approvedAt: APPROVED_LIKE.has(category) ? at : null,
        approvedByUserId: APPROVED_LIKE.has(category) ? ids.users.owner : null,
        dueDateAtApproval: APPROVED_LIKE.has(category) ? (opts.dueDate ?? null) : null,
        wasOnTime: APPROVED_LIKE.has(category) && opts.dueDate ? at <= opts.dueDate : null,
        deliveredAt: category === "delivered" ? at : null,
        completedAt: category === "completed" ? at : null,
        dueDateAtCompletion: category === "completed" ? (opts.dueDate ?? null) : null,
        cancelledAt: category === "cancelled" ? at : null,
        lastActivityAt: at,
        createdByUserId,
        createdByRole,
        sharedWithClient: opts.sharedWithClient ?? false,
        createdAt: at,
        updatedAt: at,
      })
      .returning();

    const [transition] = await tx
      .insert(schema.jobStatusTransitions)
      .values({
        organisationId: ids.organisationId,
        jobId: job.id,
        sequence: 1,
        kind: "creation",
        fromStatusId: null,
        toStatusId: statusId,
        fromCategory: null,
        toCategory: category,
        statusName: status.name,
        actorUserId: createdByUserId,
        enteredAt: at,
        editorIdAtEntry: editorId,
        photographerIdAtEntry: photographerId,
      })
      .returning({ id: schema.jobStatusTransitions.id });

    const assign = async (role: "photographer" | "editor", userId: string | null): Promise<string | null> => {
      if (!userId) return null;
      const [row] = await tx
        .insert(schema.jobAssignments)
        .values({
          organisationId: ids.organisationId,
          jobId: job.id,
          role,
          userId,
          assignedByUserId: createdByUserId,
          assignedAt: at,
          statusCategoryAtAssign: category,
        })
        .returning({ id: schema.jobAssignments.id });
      return row.id;
    };
    const assignmentIds = { photographer: await assign("photographer", photographerId), editor: await assign("editor", editorId) };

    const ctx = await systemContext(ids.organisationId, { db: tx, now: () => at, cause: "seed", requestId: "fixture" });
    const eventId = await recordEvent(tx, { ...ctx, userId: createdByUserId, isSystem: false }, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.created",
      action: "created",
      previousValue: null,
      newValue: {
        jobNumber,
        name: job.name,
        clientId: job.clientId,
        projectId: job.projectId,
        jobTypeId: job.jobTypeId,
        workflowId: job.workflowId,
        statusId,
        priority: job.priority,
        shootDate: job.shootDate,
        dueDate: job.dueDate,
        reviewDueDate: job.reviewDueDate,
        deliveryDueDate: job.deliveryDueDate,
        photographerId,
        editorId,
        estimatedHours: job.estimatedHours,
      },
      metadata: { jobNumber, jobName: job.name, fixture: true, creatorRole: createdByRole },
    });
    await tx
      .update(schema.jobStatusTransitions)
      .set({ activityEventId: eventId })
      .where(eq(schema.jobStatusTransitions.id, transition.id));

    const [fresh] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    return { job: fresh ?? job, transitionId: transition.id, eventId, assignmentIds };
  });
}

/* ------------------------------------------------------------------ */
/*  Contexts                                                           */
/* ------------------------------------------------------------------ */

/**
 * AuthContext for `userId` without cookies (same builder as the session
 * code). Throws if the user is missing/inactive — use `buildContextFromDb`
 * directly to test those cases.
 */
export async function contextFor(db: DbLike, userId: string, opts: BuildContextOptions = {}): Promise<AuthContext> {
  const ctx = await buildContextFromDb(db, userId, { requestId: "test-request", ...opts });
  if (!ctx) throw new Error(`contextFor: user ${userId} is missing or inactive`);
  return ctx;
}

/** System context bound to a test db. */
export async function systemContextFor(
  db: DbLike,
  organisationId: string,
  opts: Parameters<typeof systemContext>[1] = {},
): Promise<AuthContext> {
  return systemContext(organisationId, { requestId: "test-system", ...opts, db });
}
