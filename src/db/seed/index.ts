/**
 * Demo seed orchestration (ARCHITECTURE.md §12). `runSeed(db, options)`:
 *
 *   A. bootstraps Northlight Studios and builds its structure through the
 *      admin services (settings, users, workflows, job types, teams,
 *      clients, automations, saved views, dashboards) ~130 days ago;
 *   B. plans 160 jobs and queues every service call with its timestamp,
 *      plus the two editor deactivations, a sweep every morning, client
 *      archiving — and runs the queue in global time order;
 *   C. seeds "Other Studio" (isolation tests), marks ~70 % of notifications
 *      read, runs the final sweep at real now;
 *   D. returns counts; the CLI (src/db/seed.ts) verifies and prints them.
 *
 * Deterministic for a given "now": mulberry32(42) drives every choice
 * (every step is awaited in order, so the PRNG sequence never interleaves).
 */
import { hash } from "bcryptjs";
import { first, type Db } from "@/db/index";
import { jobs, notifications, organisations, users } from "@/db/schema";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { addCivilDays, civilDate, startOfCivilDayIso } from "@/lib/dates";
import { resetClock } from "@/server/clock";
import { buildContextFromDb } from "@/server/auth/session";
import { withTx } from "@/server/services/_shared";
import { createAutomation } from "@/server/services/automations";
import { createSavedView } from "@/server/services/savedViews";
import { putDashboardLayout } from "@/server/services/dashboards";
import { deactivateUser } from "@/server/services/users";
import { archiveClient } from "@/server/services/clients";
import { createProject } from "@/server/services/projects";
import { createJob } from "@/server/services/jobs";
import { assignEditor } from "@/server/services/assignments";
import { approveJob, completeJob, startJob, submitJob } from "@/server/services/workflow";
import { addLink } from "@/server/services/links";
import { markRead } from "@/server/services/notifications";
import { runSweep, type SweepResult } from "@/server/services/sweep";
import { CLIENTS, NORTHLIGHT, OTHER_STUDIO, OWNER, SEED_PASSWORD, STAFF, TEAMS, type SeedUserDef } from "./catalog";
import {
  bootstrapOrganisation,
  createDefaultWorkflow,
  createJobTypes,
  createQuickWorkflow,
  createSeedClient,
  createSeedTeam,
  createVideoWorkflow,
  enableTimeTracking,
  inviteSeedUser,
} from "./org";
import { NorthlightSeeder, buildSpecs } from "./northlight";
import { DAY, HOUR, MINUTE, SeedRuntime } from "./runtime";
import type { PreparedSecret } from "@/server/services/users";
import type { Tx } from "@/server/services/_shared";
import type { AuthContext } from "@/lib/types";
import type { JobTypeName } from "./catalog";

export interface SeedOptions {
  /** "Today" of the generated history (default: the real current time). */
  now?: Date;
  log?: (line: string) => void;
  /** bcrypt cost for the shared demo password hash (default 10). */
  bcryptCost?: number;
}

export interface SeedResult {
  northlightId: string;
  otherStudioId: string;
  stepsRun: number;
  skipped: string[];
  durationsMs: Record<string, number>;
  finalSweeps: SweepResult[];
  notificationsRead: { read: number; total: number };
}

export async function runSeed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.log ?? (() => {});
  const nowMs = (options.now ?? new Date()).getTime();
  const durations: Record<string, number> = {};
  let mark = Date.now();
  const lap = (name: string) => {
    const t = Date.now();
    durations[name] = t - mark;
    mark = t;
  };

  const [existing] = await db.select({ n: count() }).from(organisations);
  if ((existing?.n ?? 0) > 0) {
    throw new Error("The database already has organisations. Run `npm run db:reset` for a fresh demo database.");
  }

  const passwordHash = await hash(SEED_PASSWORD, options.bcryptCost ?? 10);
  const secret: PreparedSecret = { tempPassword: SEED_PASSWORD, passwordHash };
  const rt = new SeedRuntime(db, nowMs, log);
  lap("hash");

  try {
    /* ---------------- A. Northlight structure ---------------- */
    const t0 = nowMs - 130 * DAY;
    let t = t0;
    const at = (ms: number) => {
      t = ms;
      rt.setTime(t);
    };
    const tick = (minutes = 1) => at(t + minutes * MINUTE);

    at(t0);
    const { organisationId: nl, ownerId } = await bootstrapOrganisation(rt, NORTHLIGHT, OWNER, passwordHash);
    tick(5);
    await enableTimeTracking(rt, ownerId);
    tick(5);
    const defaultWf = await createDefaultWorkflow(rt, ownerId);
    tick(10);
    const quickWf = await createQuickWorkflow(rt, ownerId);
    tick(15);
    const videoWf = await createVideoWorkflow(rt, ownerId);
    tick(20);
    const workflows = { default: defaultWf, quick: quickWf, video: videoWf };
    const jobTypes: Record<JobTypeName, string> = await createJobTypes(rt, ownerId, workflows);

    at(t0 + 2 * HOUR);
    const managers = STAFF.filter((u) => u.role === "manager");
    for (const m of managers) {
      await inviteSeedUser(rt, NORTHLIGHT.slug, ownerId, m, secret);
      tick(3);
    }
    at(t0 + DAY + 9 * HOUR);
    const manager1 = rt.user(NORTHLIGHT.slug, "manager1");
    const manager2 = rt.user(NORTHLIGHT.slug, "manager2");
    for (const u of STAFF.filter((x) => x.role !== "manager")) {
      await inviteSeedUser(rt, NORTHLIGHT.slug, rt.rng.chance(0.5) ? manager1 : ownerId, u, secret);
      tick(rt.rng.int(2, 9));
    }

    at(t0 + 2 * DAY + 10 * HOUR);
    for (const team of TEAMS) {
      await createSeedTeam(rt, manager1, {
        name: team.name,
        description: team.description,
        leadUserId: rt.user(NORTHLIGHT.slug, team.lead),
        memberIds: team.members.map((k) => rt.user(NORTHLIGHT.slug, k)),
      });
      tick(4);
    }

    at(t0 + 2 * DAY + 13 * HOUR);
    const clients: { def: (typeof CLIENTS)[number]; id: string }[] = [];
    for (const def of CLIENTS) {
      const id = await createSeedClient(rt, rt.rng.chance(0.5) ? manager1 : manager2, {
        name: def.name,
        contactName: def.contactName,
        email: def.email,
        phone: def.phone,
      });
      tick(rt.rng.int(3, 15));
      clients.push({ def, id });
    }

    at(t0 + 3 * DAY + 9 * HOUR);
    await seedAutomations(rt, manager1, ownerId);

    at(t0 + 4 * DAY + 10 * HOUR);
    await seedSavedViews(rt, manager1);
    at(t0 + 5 * DAY + 9 * HOUR);
    await seedDashboards(rt, ownerId);
    lap("structure");

    /* ---------------- B. jobs + timeline ---------------- */
    const seeder = new NorthlightSeeder(rt, { organisationId: nl, workflows, jobTypes, clients });
    seeder.plan(buildSpecs());
    seeder.schedule();


    // editor13 leaves 10 days ago: their open jobs go to editor05 (reassignment history).
    rt.schedule(seeder.deactivate13At, "deactivate editor13", async () => {
      const target = rt.user(NORTHLIGHT.slug, "editor13");
      const version = await userVersion(rt, target);
      await rt.act(ownerId, (tx, ctx) =>
        deactivateUser(tx, ctx, { userId: target, reassignTo: rt.user(NORTHLIGHT.slug, "editor05"), reason: "Left the studio", expectedVersion: version }),
      );
    });
    // editor11 is deactivated 3 days ago without a hand-over (editor-unavailable bottleneck).
    rt.schedule(seeder.deactivate11At, "deactivate editor11", async () => {
      const target = rt.user(NORTHLIGHT.slug, "editor11");
      const version = await userVersion(rt, target);
      await rt.act(manager1, (tx, ctx) => deactivateUser(tx, ctx, { userId: target, reason: "Extended leave", expectedVersion: version }));
    });
    // Two agencies stopped booking: archived once all their jobs are done.
    rt.schedule(nowMs - 2 * DAY, "archive clients", async () => {
      for (const c of clients.filter((x) => x.def.archived)) {
        await rt.act(manager1, (tx, ctx) => archiveClient(tx, ctx, { clientId: c.id }));
      }
    });
    // The lazy sweep runs every morning (overdue flags, workload bands, editor-unavailable notices).
    const tz = NORTHLIGHT.timezone;
    let day = addCivilDays(civilDate(new Date(t0 + 7 * DAY), tz) as string, 0);
    const today = civilDate(new Date(nowMs), tz) as string;
    while (day <= today) {
      const sweepAt = Date.parse(startOfCivilDayIso(day, tz)) + 7 * HOUR + 30 * MINUTE;
      if (sweepAt < nowMs - 5 * MINUTE) {
        rt.schedule(sweepAt, `sweep ${day}`, async () => {
          const result = await runSweep(db, nl);
          if (result.errors.length > 0) throw new Error(`sweep errors: ${JSON.stringify(result.errors)}`);
        });
      }
      day = addCivilDays(day, 1);
    }
    log(`seed: ${seeder.plans.length} jobs planned, ${rt.queued} steps queued`);
    try {
      await rt.runQueue();
    } finally {
      const top = [...rt.timings.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
      log(`seed: slowest step kinds: ${top.map(([k, v]) => `${k} ${v.n}×${(v.ms / v.n).toFixed(1)}ms=${(v.ms / 1000).toFixed(1)}s`).join(", ")}`);
    }
    lap("history");

    /* ---------------- C. Other Studio, notifications, final sweep ---------------- */
    const otherStudioId = await seedOtherStudio(rt, passwordHash, secret);
    lap("other studio");

    const notificationsRead = await markNotificationsRead(rt);
    lap("notifications");

    rt.setTime(nowMs);
    const finalSweeps = [await runSweep(db, nl), await runSweep(db, otherStudioId)];
    for (const r of finalSweeps) if (r.errors.length > 0) throw new Error(`final sweep errors: ${JSON.stringify(r.errors)}`);
    lap("final sweep");

    return {
      northlightId: nl,
      otherStudioId,
      stepsRun: rt.stepsRun,
      skipped: rt.skipped,
      durationsMs: durations,
      finalSweeps,
      notificationsRead,
    };
  } finally {
    resetClock();
  }
}

async function userVersion(rt: SeedRuntime, userId: string): Promise<number> {
  const row = await first(rt.db.select({ version: users.version }).from(users).where(eq(users.id, userId)));
  if (!row) throw new Error(`seed: user ${userId} missing`);
  return row.version;
}

/* ------------------------------------------------------------------ */
/*  Automations, saved views, dashboards                               */
/* ------------------------------------------------------------------ */

async function seedAutomations(rt: SeedRuntime, managerId: string, ownerId: string): Promise<void> {
  const create = async (actor: string, input: Record<string, unknown>) => {
    const row = await rt.act(actor, (tx, ctx) => createAutomation(tx, ctx, input));
    rt.setTime(Date.parse(row.createdAt) + 4 * MINUTE);
    return row.id;
  };
  // The photographer (work_submitted) and the editor (job_overdue) already get a
  // built-in notice for these events, so the example rules target the managers,
  // who would otherwise hear nothing (and the engine never double-notifies, §7).
  await create(managerId, {
    name: "Submitted → notify managers",
    description: "Let the managers know edits have landed in review (the photographer is told automatically).",
    trigger: { type: "status_changed", toCategory: "submitted" },
    actions: [{ type: "notify", target: "managers", message: "Edits are ready for review." }],
  });
  await create(managerId, {
    name: "Overdue → notify managers",
    description: "Escalate jobs that pass their editing deadline (the editor and photographer are told automatically).",
    trigger: { type: "job_overdue" },
    actions: [{ type: "notify", target: "managers", message: "A job just went overdue." }],
  });
  await create(managerId, {
    name: "Repeat revision → back to the original editor",
    description: "When a job needs a second (or later) revision, hand it back to the editor who first worked on it.",
    trigger: { type: "revision_requested" },
    conditions: [{ field: "revisionCount", op: "gte", value: 2 }],
    actions: [{ type: "assign_editor", target: "original_editor" }],
  });
  await create(ownerId, {
    name: "Approved → complete",
    description: "Close jobs automatically once approved. Kept switched off: photographers still deliver first.",
    isEnabled: false,
    trigger: { type: "status_changed", toCategory: "approved" },
    actions: [{ type: "transition", toCategory: "completed", reason: "Auto-completed on approval" }],
  });
  await create(managerId, {
    name: "Editor overloaded → notify managers",
    description: "Flag editors who tip into the overloaded band.",
    trigger: { type: "workload_threshold", band: "overloaded" },
    actions: [{ type: "notify", target: "managers", message: "An editor is overloaded. Consider rebalancing." }],
  });
}

const VIEW_COLUMNS = ["job", "client", "editor", "status", "priority", "dueDate", "daysRemaining", "lastActivity"] as const;

async function seedSavedViews(rt: SeedRuntime, managerId: string): Promise<void> {
  const shared: [string, string][] = [
    ["Overdue", "overdue"],
    ["Awaiting Review", "awaiting_review"],
    ["Due This Week", "due_this_week"],
    ["Unassigned", "unassigned"],
  ];
  for (const [name, quick] of shared) {
    await rt.act(managerId, (tx, ctx) =>
      createSavedView(tx, ctx, {
        name,
        scope: "all_work",
        isShared: true,
        config: { filters: { quick: [quick] }, sort: [{ column: "dueDate", dir: "asc" }], groupBy: null, columns: [...VIEW_COLUMNS] },
      }),
    );
  }
  for (const key of ["editor01", "editor03", "photographer01", "manager2"]) {
    await rt.act(rt.user(NORTHLIGHT.slug, key), (tx, ctx) =>
      createSavedView(tx, ctx, {
        name: "My Jobs",
        scope: "all_work",
        isDefault: true,
        config: { filters: { quick: ["my_jobs"] }, sort: [{ column: "dueDate", dir: "asc" }], groupBy: "status", columns: [...VIEW_COLUMNS] },
      }),
    );
  }
}

async function seedDashboards(rt: SeedRuntime, ownerId: string): Promise<void> {
  const w = (id: string, type: string, x: number, y: number, width: number, h: number) => ({ id, type, x, y, w: width, h });
  await rt.act(ownerId, (tx, ctx) =>
    putDashboardLayout(tx, ctx, {
      expectedVersion: 0,
      layout: {
        widgets: [
          w("kpis", "kpis", 0, 0, 12, 2),
          w("bottlenecks", "bottlenecks", 0, 2, 12, 2),
          w("team_workload", "team_workload", 0, 4, 7, 4),
          w("overdue", "overdue", 7, 4, 5, 4),
          w("editor_performance", "editor_performance", 0, 8, 6, 4),
          w("revision_rate", "revision_rate", 6, 8, 3, 4),
          w("completion_rate", "completion_rate", 9, 8, 3, 4),
          w("recent_activity", "recent_activity", 0, 12, 12, 4),
        ],
      },
    }),
  );
  await rt.act(rt.user(NORTHLIGHT.slug, "editor01"), (tx, ctx) =>
    putDashboardLayout(tx, ctx, {
      expectedVersion: 0,
      layout: {
        widgets: [
          w("my_workload", "my_workload", 0, 0, 8, 3),
          w("kpis", "kpis", 8, 0, 4, 3),
          w("due_today", "due_today", 0, 3, 6, 4),
          w("overdue", "overdue", 6, 3, 6, 4),
          w("my_performance", "my_performance", 0, 7, 12, 3),
        ],
      },
    }),
  );
}

/* ------------------------------------------------------------------ */
/*  Other Studio (cross-organisation isolation fixture)                */
/* ------------------------------------------------------------------ */

const OTHER_OWNER: SeedUserDef = {
  key: "owner",
  email: "owner@other.test",
  name: "Morgan Ellis",
  role: "owner",
  title: "Owner",
  avatarColour: "#d97706",
};
const OTHER_EDITOR: SeedUserDef = {
  key: "editor",
  email: "editor@other.test",
  name: "Riley Chen",
  role: "editor",
  title: "Editor",
  avatarColour: "#0891b2",
  capacityHoursPerWeek: 30,
};

async function seedOtherStudio(rt: SeedRuntime, passwordHash: string, secret: PreparedSecret): Promise<string> {
  const now = rt.nowMs;
  let t = now - 60 * DAY;
  const at = (ms: number) => {
    t = ms;
    rt.setTime(t);
  };
  at(t);
  const { organisationId, ownerId } = await bootstrapOrganisation(rt, OTHER_STUDIO, OTHER_OWNER, passwordHash);
  at(t + 10 * MINUTE);
  const wf = await createDefaultWorkflow(rt, ownerId);
  at(t + 20 * MINUTE);
  const jobTypes = await createJobTypes(rt, ownerId, { default: wf, quick: wf, video: wf });
  at(t + HOUR);
  const editorId = await inviteSeedUser(rt, OTHER_STUDIO.slug, ownerId, OTHER_EDITOR, secret);
  at(t + 2 * HOUR);
  const clientId = await createSeedClient(rt, ownerId, { name: "Lakeside Property Co", contactName: "Dana Wells", email: "dana@lakesideproperty.example", phone: "02 9970 1188" });
  at(t + 2 * HOUR + 10 * MINUTE);
  const projectId = (
    await rt.act(ownerId, (tx, ctx) => createProject(tx, ctx, { clientId, name: "8 Lakeview Parade", address: "8 Lakeview Parade, Narrabeen NSW 2101" }))
  ).id;

  const tz = OTHER_STUDIO.timezone;
  const civil = (ms: number) => civilDate(new Date(ms), tz) as string;
  const create = async (ms: number, name: string, type: JobTypeName, dueDays: number) => {
    at(ms);
    const created = await rt.act(ownerId, (tx, ctx) =>
      createJob(tx, ctx, { name, projectId, jobTypeId: jobTypes[type], photographerId: ownerId, shootDate: civil(ms), dueDate: addCivilDays(civil(ms), dueDays) }),
    );
    return created.job.id;
  };
  // The version is read on the root db BEFORE act() opens its transaction (never inside it).
  const versionOf = async (jobId: string) => (await first(rt.db.select({ version: jobs.version }).from(jobs).where(eq(jobs.id, jobId))))?.version ?? 0;
  type JobStep = (tx: Tx, ctx: AuthContext, input: { jobId: string; expectedVersion: number }) => Promise<unknown>;
  const step = async (actor: string, jobId: string, fn: JobStep) => {
    const expectedVersion = await versionOf(jobId);
    await rt.act(actor, (tx, ctx) => fn(tx, ctx, { jobId, expectedVersion }));
  };

  // Job 1: completed a month ago.
  const j1 = await create(now - 30 * DAY, "8 Lakeview Parade · Listing photos", "Real Estate", 1);
  at(now - 30 * DAY + 20 * MINUTE);
  await rt.act(ownerId, (tx, ctx) => addLink(tx, ctx, { jobId: j1, kind: "raw_files", url: "https://www.dropbox.com/scl/fo/otherstudio01/raw" }));
  at(now - 30 * DAY + 2 * HOUR);
  await step(ownerId, j1, (tx, ctx, v) => assignEditor(tx, ctx, { ...v, userId: editorId }));
  at(now - 30 * DAY + 5 * HOUR);
  await step(editorId, j1, (tx, ctx, v) => startJob(tx, ctx, v));
  at(now - 30 * DAY + 9 * HOUR);
  await rt.act(editorId, (tx, ctx) => addLink(tx, ctx, { jobId: j1, kind: "finished_files", url: "https://drive.google.com/drive/folders/otherstudio01" }));
  await step(editorId, j1, (tx, ctx, v) => submitJob(tx, ctx, v));
  at(now - 29 * DAY);
  await step(ownerId, j1, (tx, ctx, v) => approveJob(tx, ctx, v));
  at(now - 28 * DAY);
  await step(ownerId, j1, (tx, ctx, v) => completeJob(tx, ctx, v));

  // Job 2: in progress.
  const j2 = await create(now - 4 * DAY, "8 Lakeview Parade · Drone stills", "Drone", 6);
  at(now - 4 * DAY + 3 * HOUR);
  await step(ownerId, j2, (tx, ctx, v) => assignEditor(tx, ctx, { ...v, userId: editorId }));
  at(now - 3 * DAY);
  await step(editorId, j2, (tx, ctx, v) => startJob(tx, ctx, v));

  // Job 3: new.
  await create(now - 1 * DAY, "8 Lakeview Parade · Floor plan", "Floor Plans", 3);
  return organisationId;
}

/* ------------------------------------------------------------------ */
/*  Notifications (~70 % read)                                         */
/* ------------------------------------------------------------------ */

async function markNotificationsRead(rt: SeedRuntime): Promise<{ read: number; total: number }> {
  const all = await rt.db.select({ id: users.id }).from(users).where(eq(users.isActive, true)).orderBy(asc(users.createdAt), asc(users.id));
  let read = 0;
  let current = rt.iso(rt.nowMs);
  for (const { id: userId } of all) {
    const ctx = await buildContextFromDb(rt.db, userId, { now: () => current, cause: "seed", requestId: "seed-notifications" });
    if (!ctx) continue;
    const rows = await rt.db
      .select({ id: notifications.id, createdAt: notifications.createdAt })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
    await withTx(
      async (tx) => {
        for (const n of rows) {
          const created = Date.parse(n.createdAt);
          const ageDays = (rt.nowMs - created) / DAY;
          const p = ageDays > 7 ? 0.94 : ageDays > 2 ? 0.75 : 0.35;
          if (!rt.rng.chance(p)) continue;
          const readAt = Math.min(created + rt.rng.range(3, 20 * 60) * MINUTE, rt.nowMs - MINUTE);
          current = rt.iso(Math.max(readAt, created));
          await markRead(tx, ctx, { notificationId: n.id });
          read += 1;
        }
      },
      { db: rt.db },
    );
  }
  const total = (await first(rt.db.select({ n: count() }).from(notifications)))?.n ?? 0;
  return { read, total };
}
