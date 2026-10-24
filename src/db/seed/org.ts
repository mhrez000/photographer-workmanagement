/**
 * Organisation bootstrap + admin structure for the demo seed.
 *
 * The organisation, its settings row, the first owner and the structure every studio starts with (default
 * workflow, types of shoot) come from the SAME two service functions sign-up uses
 * (`createOrganisationWithOwner` + `bootstrapOrganisation` in src/server/services/organisations.ts), so the
 * demo studio is built exactly like a real one; `markDemoStudios` flags it as the demo studio as the LAST step. Everything else (users, extra workflows, teams, clients,
 * projects, automations, saved views, dashboards) goes through the admin services as the owner.
 */
import { eq, inArray } from "drizzle-orm";
import { first, type Db } from "@/db/index";
import { jobTypes as jobTypesTable, organisations } from "@/db/schema";
import { DEFAULT_JOB_TYPES, EDITOR_FLAGS, MEMBER_FLAGS, type PermissionFlag, type TransitionRole } from "@/lib/constants";
import type { WorkflowStatus } from "@/lib/types";
import { bootstrapOrganisation as bootstrapStructure, createOrganisationWithOwner } from "@/server/services/organisations";
import { createWorkflow, addStatus, addTransition, archiveStatus, reorderStatuses, updateStatus, type WorkflowGraph } from "@/server/services/workflows";
import { updateJobType } from "@/server/services/jobTypes";
import { inviteUser, setPermissions, type PreparedSecret } from "@/server/services/users";
import { createTeam } from "@/server/services/teams";
import { createClient } from "@/server/services/clients";
import { updateSettings } from "@/server/services/settings";
import type { SeedUserDef, WorkflowKind } from "./catalog";
import { TYPE_WORKFLOW, type JobTypeName } from "./catalog";
import type { SeedRuntime } from "./runtime";

export interface OrgDef {
  name: string;
  slug: string;
  timezone: string;
}

export interface BootstrappedOrg {
  organisationId: string;
  ownerId: string;
  /** The default workflow (13 statuses, every default edge + a cancel edge per open status). */
  workflow: WorkflowRefs;
  /** DEFAULT_JOB_TYPES, bound to the default workflow. */
  jobTypes: Record<JobTypeName, string>;
}

/**
 * Organisation + settings + owner + structure in ONE transaction through the sign-up services (cause "seed",
 * actor = the owner). `usualDays`: per-type "usual days to edit" (`null` = none, the full fixture's shape).
 */
export async function bootstrapOrganisation(
  rt: SeedRuntime,
  def: OrgDef,
  owner: SeedUserDef,
  passwordHash: string,
  opts: { usualDays?: Readonly<Record<string, number>> | null } = {},
): Promise<BootstrappedOrg> {
  if (owner.role !== "photographer" || !owner.isAdmin) throw new Error(`seed: the first owner ${owner.email} must be an admin photographer`);
  return rt.db.transaction(async (tx) => {
    const created = await createOrganisationWithOwner(tx, {
      name: def.name,
      slug: def.slug,
      timezone: def.timezone,
      owner: { name: owner.name, email: owner.email, passwordHash, title: owner.title, avatarColour: owner.avatarColour },
      cause: "seed",
      requestId: "seed-bootstrap",
    });
    const structure = await bootstrapStructure(tx, {
      organisationId: created.organisationId,
      ownerUserId: created.ownerId,
      ctx: created.ctx,
      usualDays: opts.usualDays,
    });
    rt.registerUser(def.slug, owner.key, created.ownerId, created.organisationId);
    return {
      organisationId: created.organisationId,
      ownerId: created.ownerId,
      workflow: { id: structure.workflow.workflow.id, statuses: structure.statuses },
      jobTypes: structure.jobTypes as Record<JobTypeName, string>,
    };
  });
}

/**
 * Accounts (docs/ACCOUNTS.md "Demo studio"): `SEED_DEMO=off` seeds ordinary studios instead of demo studios (the
 * e2e database does this: its specs invite people and reset passwords in the seeded studio, which a demo studio
 * refuses). Default on.
 */
export function seedDemoEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env.SEED_DEMO?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

/**
 * Flags the seeded studios as demo studios (`organisations.is_demo = true`). Runs as the LAST seed step: the seed
 * builds the studio through the real services (invites, temp passwords, deactivations), which a demo studio refuses.
 */
export async function markDemoStudios(db: Db, organisationIds: readonly string[]): Promise<void> {
  if (organisationIds.length === 0) return;
  await db.update(organisations).set({ isDemo: true }).where(inArray(organisations.id, [...organisationIds]));
}

/**
 * Invites `def` as `actorId` (shared pre-hashed secret, so no bcrypt per user)
 * with its admin bit and permission switches passed EXPLICITLY to `inviteUser`
 * (docs/ROLES.md §13: the seed never relies on column / invite defaults).
 */
export async function inviteSeedUser(rt: SeedRuntime, orgSlug: string, actorId: string, def: SeedUserDef, secret: PreparedSecret): Promise<string> {
  if (def.role === "client") throw new Error(`seed: ${def.email} is a client user; use inviteSeedClientUser`);
  const keys: readonly PermissionFlag[] = def.role === "editor" ? EDITOR_FLAGS : MEMBER_FLAGS;
  const flags: Partial<Record<PermissionFlag, boolean>> = {};
  for (const k of keys) if (def.flags?.[k] !== undefined) flags[k] = def.flags[k];
  const result = await rt.act(actorId, (tx, ctx) =>
    inviteUser(
      tx,
      ctx,
      {
        email: def.email,
        name: def.name,
        role: def.role,
        title: def.title,
        avatarColour: def.avatarColour,
        capacityHoursPerWeek: def.capacityHoursPerWeek ?? null,
        ...(def.role === "photographer" && def.isAdmin ? { isAdmin: true } : {}),
        flags,
      },
      secret,
    ),
  );
  rt.registerUser(orgSlug, def.key, result.user.id, result.user.organisationId);
  return result.user.id;
}

/**
 * Sets a user's permission switches as `actorId` (an admin) through
 * `setPermissions` (`user.flags_changed` with only the changed switches).
 */
export async function setSeedPermissions(rt: SeedRuntime, actorId: string, userId: string, flags: Partial<Record<PermissionFlag, boolean>>): Promise<void> {
  await rt.act(actorId, (tx, ctx) => setPermissions(tx, ctx, { userId, ...flags }));
}

/* ------------------------------------------------------------------ */
/*  Workflows + job types                                              */
/* ------------------------------------------------------------------ */

export interface WorkflowRefs {
  id: string;
  /** status key → id (non-archived only). */
  statuses: Record<string, string>;
}

function refsOf(graph: WorkflowGraph): WorkflowRefs {
  const statuses: Record<string, string> = {};
  for (const s of graph.statuses) if (!s.archivedAt) statuses[s.key] = s.id;
  return { id: graph.workflow.id, statuses };
}

function statusByKey(graph: WorkflowGraph, key: string): WorkflowStatus {
  const s = graph.statuses.find((x) => x.key === key && !x.archivedAt);
  if (!s) throw new Error(`seed: workflow ${graph.workflow.name} has no status "${key}"`);
  return s;
}

/** Roles v2 edge roles (docs/ROLES.md §5.1): editor-side edges; reviewer-side / cancel / unassign edges. */
const OME: TransitionRole[] = ["admin", "editor"];
const OMP: TransitionRole[] = ["photographer"];

/** "Quick Turnaround": the default graph without accepted / review / delivered. */
export async function createQuickWorkflow(rt: SeedRuntime, ownerId: string): Promise<WorkflowRefs> {
  let graph = await rt.act(ownerId, (tx, ctx) =>
    createWorkflow(tx, ctx, {
      name: "Quick Turnaround",
      description: "Same-day retouching and virtual staging: no accept step, no separate review, no delivery step.",
      from: "default",
    }),
  );
  for (const key of ["accepted", "review", "delivered"]) {
    const status = statusByKey(graph, key);
    graph = (await rt.act(ownerId, (tx, ctx) => archiveStatus(tx, ctx, { statusId: status.id, expectedVersion: status.version }))).graph;
  }
  if (graph.problems.length > 0) throw new Error(`seed: Quick Turnaround has problems: ${graph.problems.join("; ")}`);
  return refsOf(graph);
}

/** "Video Production": two in_progress stages (Rough Cut / Final Cut) and a review named "Client Review". */
export async function createVideoWorkflow(rt: SeedRuntime, ownerId: string): Promise<WorkflowRefs> {
  let graph = await rt.act(ownerId, (tx, ctx) =>
    createWorkflow(tx, ctx, { name: "Video Production", description: "Rough cut, final cut, client review.", from: "default" }),
  );
  const rough = statusByKey(graph, "in_progress");
  graph = (await rt.act(ownerId, (tx, ctx) => updateStatus(tx, ctx, { statusId: rough.id, expectedVersion: rough.version, name: "Rough Cut" }))).graph;
  const review = statusByKey(graph, "review");
  graph = (await rt.act(ownerId, (tx, ctx) => updateStatus(tx, ctx, { statusId: review.id, expectedVersion: review.version, name: "Client Review" }))).graph;
  const added = await rt.act(ownerId, (tx, ctx) =>
    addStatus(tx, ctx, {
      workflowId: graph.workflow.id,
      name: "Final Cut",
      key: "final_cut",
      category: "in_progress",
      colour: "#2563eb",
      description: "Picture lock, grade and sound mix.",
    }),
  );
  graph = added.graph;
  const finalCut = added.status;
  const order = graph.statuses.filter((s) => !s.archivedAt && s.id !== finalCut.id);
  const roughIndex = order.findIndex((s) => s.id === rough.id);
  order.splice(roughIndex + 1, 0, finalCut);
  graph = await rt.act(ownerId, (tx, ctx) => reorderStatuses(tx, ctx, { workflowId: graph.workflow.id, statusIds: order.map((s) => s.id) }));
  const submitted = statusByKey(graph, "submitted");
  const cancelled = statusByKey(graph, "cancelled");
  const ready = statusByKey(graph, "ready");
  const edges: { from: string; to: string; label: string; roles: TransitionRole[]; assigneeOnly?: boolean }[] = [
    { from: rough.id, to: finalCut.id, label: "Move to Final Cut", roles: OME, assigneeOnly: true },
    { from: finalCut.id, to: submitted.id, label: "Submit for review", roles: OME, assigneeOnly: true },
    { from: finalCut.id, to: ready.id, label: "Unassign", roles: OMP },
    { from: finalCut.id, to: cancelled.id, label: "Cancel", roles: OMP },
  ];
  for (const e of edges) {
    graph = (
      await rt.act(ownerId, (tx, ctx) =>
        addTransition(tx, ctx, {
          workflowId: graph.workflow.id,
          fromStatusId: e.from,
          toStatusId: e.to,
          label: e.label,
          allowedRoles: e.roles,
          assigneeOnly: e.assigneeOnly ?? false,
        }),
      )
    ).graph;
  }
  if (graph.problems.length > 0) throw new Error(`seed: Video Production has problems: ${graph.problems.join("; ")}`);
  return refsOf(graph);
}

/**
 * The full fixture binds some types of shoot to its custom workflows (Video → Video Production; Retouching /
 * Virtual Staging → Quick Turnaround) AFTER the bootstrap created them on the default workflow: one audited
 * `job_type.updated` per rebound type, exactly what an owner does under Settings → Types of shoot.
 */
export async function bindJobTypeWorkflows(
  rt: SeedRuntime,
  actorId: string,
  jobTypes: Record<JobTypeName, string>,
  workflows: Record<WorkflowKind, WorkflowRefs>,
): Promise<Record<JobTypeName, string>> {
  for (const jt of DEFAULT_JOB_TYPES) {
    const name = jt.name as JobTypeName;
    const kind = TYPE_WORKFLOW[name];
    if (kind === "default") continue;
    const row = await first(rt.db.select({ version: jobTypesTable.version }).from(jobTypesTable).where(eq(jobTypesTable.id, jobTypes[name])));
    if (!row) throw new Error(`seed: job type ${name} missing`);
    await rt.act(actorId, (tx, ctx) => updateJobType(tx, ctx, { jobTypeId: jobTypes[name], workflowId: workflows[kind].id, expectedVersion: row.version }));
  }
  return jobTypes;
}

export async function enableTimeTracking(rt: SeedRuntime, ownerId: string): Promise<void> {
  await rt.act(ownerId, (tx, ctx) => updateSettings(tx, ctx, { timeTrackingEnabled: true }));
}

/**
 * Settings → Studio → Advanced tools ON (SIMPLIFICATION-PLAN §8 safety rule): the full fixture is "an
 * existing studio that already uses custom workflows and automations", so it keeps every Advanced page.
 * Migration 0004 flips this for real databases; a seed runs on an empty one, so the owner does it here
 * through the same service (one audited `settings.updated` event). The small demo never calls this.
 */
export async function enableAdvancedTools(rt: SeedRuntime, ownerId: string): Promise<void> {
  await rt.act(ownerId, (tx, ctx) => updateSettings(tx, ctx, { advancedToolsEnabled: true }));
}

export async function createSeedTeam(
  rt: SeedRuntime,
  actorId: string,
  input: { name: string; description: string; leadUserId: string; memberIds: string[] },
): Promise<string> {
  return (await rt.act(actorId, (tx, ctx) => createTeam(tx, ctx, input))).team.id;
}

export async function createSeedClient(
  rt: SeedRuntime,
  actorId: string,
  input: { name: string; contactName: string; email: string; phone: string },
): Promise<string> {
  return (await rt.act(actorId, (tx, ctx) => createClient(tx, ctx, input))).id;
}
