/**
 * Organisation bootstrap + admin structure for the demo seed.
 *
 * Only the organisation row, its settings row and the first owner are
 * inserted directly: no service creates an organisation (there is no
 * sign-up flow in v1), and every later service needs an owner to act as.
 * The owner's `user.created` event is still written through recordEvent().
 * Everything else (settings, users, workflows, job types, teams, clients,
 * projects, automations, saved views, dashboards) goes through the services.
 */
import { one } from "@/db/index";
import { organisationSettings, organisations, users } from "@/db/schema";
import { DEFAULT_JOB_TYPES, DEFAULT_WORKFLOW_NAME, type Role } from "@/lib/constants";
import type { WorkflowStatus } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { systemContext } from "@/server/auth/session";
import { nowIso } from "@/server/clock";
import { createWorkflow, addStatus, addTransition, archiveStatus, reorderStatuses, updateStatus, type WorkflowGraph } from "@/server/services/workflows";
import { createJobType } from "@/server/services/jobTypes";
import { inviteUser, type PreparedSecret } from "@/server/services/users";
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

/** Inserts the organisation, its settings row and the first owner (the only raw inserts in the seed). */
export async function bootstrapOrganisation(
  rt: SeedRuntime,
  def: OrgDef,
  owner: SeedUserDef,
  passwordHash: string,
): Promise<{ organisationId: string; ownerId: string }> {
  return rt.db.transaction(async (tx) => {
    const at = nowIso();
    const org = await one(
      tx.insert(organisations).values({ name: def.name, slug: def.slug, createdAt: at, updatedAt: at }).returning({ id: organisations.id }),
      "organisation",
    );
    await tx.insert(organisationSettings).values({ organisationId: org.id, timezone: def.timezone, updatedAt: at });
    const user = await one(
      tx
        .insert(users)
        .values({
          organisationId: org.id,
          email: owner.email,
          passwordHash,
          name: owner.name,
          role: owner.role,
          title: owner.title,
          avatarColour: owner.avatarColour,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: users.id }),
      "owner",
    );
    const sys = await systemContext(org.id, { db: tx, cause: "seed", requestId: "seed-bootstrap" });
    await recordEvent(tx, sys, {
      entityType: "user",
      entityId: user.id,
      eventType: "user.created",
      action: "created",
      previousValue: null,
      newValue: { name: owner.name, email: owner.email, role: owner.role, title: owner.title },
      metadata: { targetUserId: user.id, bootstrap: true },
    });
    rt.registerUser(def.slug, owner.key, user.id, org.id);
    return { organisationId: org.id, ownerId: user.id };
  });
}

/** Invites `def` as `actorId` (shared pre-hashed secret, so no bcrypt per user). */
export async function inviteSeedUser(rt: SeedRuntime, orgSlug: string, actorId: string, def: SeedUserDef, secret: PreparedSecret): Promise<string> {
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
        canViewTeamWorkloads: def.canViewTeamWorkloads ?? false,
        canViewAnalytics: def.canViewAnalytics ?? false,
      },
      secret,
    ),
  );
  rt.registerUser(orgSlug, def.key, result.user.id, result.user.organisationId);
  return result.user.id;
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

const OME: Role[] = ["owner", "manager", "editor"];
const OMP: Role[] = ["owner", "manager", "photographer"];

/** Default workflow (the built-in template, made the organisation default). */
export async function createDefaultWorkflow(rt: SeedRuntime, ownerId: string): Promise<WorkflowRefs> {
  const graph = await rt.act(ownerId, (tx, ctx) =>
    createWorkflow(tx, ctx, { name: DEFAULT_WORKFLOW_NAME, description: "Shoot, edit, review, deliver.", from: "default", isDefault: true }),
  );
  return refsOf(graph);
}

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
  const edges: { from: string; to: string; label: string; roles: Role[]; assigneeOnly?: boolean }[] = [
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

/** DEFAULT_JOB_TYPES, each bound to its workflow (Video → Video Production; Retouching / Virtual Staging → Quick Turnaround). */
export async function createJobTypes(rt: SeedRuntime, actorId: string, workflows: Record<WorkflowKind, WorkflowRefs>): Promise<Record<JobTypeName, string>> {
  const out = {} as Record<JobTypeName, string>;
  for (const [i, jt] of DEFAULT_JOB_TYPES.entries()) {
    const name = jt.name as JobTypeName;
    const row = await rt.act(actorId, (tx, ctx) =>
      createJobType(tx, ctx, {
        name,
        colour: jt.colour,
        workflowId: workflows[TYPE_WORKFLOW[name]].id,
        defaultEstimatedHours: jt.defaultEstimatedHours,
        sortOrder: i,
      }),
    );
    out[name] = row.id;
  }
  return out;
}

export async function enableTimeTracking(rt: SeedRuntime, ownerId: string): Promise<void> {
  await rt.act(ownerId, (tx, ctx) => updateSettings(tx, ctx, { timeTrackingEnabled: true }));
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
