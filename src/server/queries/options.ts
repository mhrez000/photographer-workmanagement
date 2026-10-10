/**
 * Lightweight picker lists for client islands (assign dialogs, @mention
 * autocomplete, create-job client → project cascade). Read-only; every list
 * goes through the same permission-checked queries as the full pages, then
 * projects down to a few fields.
 *
 *   GET /api/users/options?role=editor&jobId=&includeInactive=1&excludeSelf=1
 *   GET /api/clients/options?q=
 *   GET /api/projects/options?clientId=&q=
 */
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { ROLES } from "@/lib/constants";
import type { AuthContext, ClientOption, ProjectOption, UserOption, UserRef } from "@/lib/types";
import { userCanViewJob } from "@/server/services/_collab";
import { parseInput } from "@/server/services/_shared";
import { loadVisibleJob } from "@/server/services/workflow";
import { listClients } from "./clients";
import { listProjects } from "./projects";
import { listUsers } from "./users";
import { canViewTeamWorkloads, computeWorkloads } from "./workloads";

const toList = (v: unknown) =>
  v === undefined || v === ""
    ? undefined
    : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
const one = (v: unknown) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v);
const bool = z.preprocess((v) => {
  const s = one(v);
  return s === undefined ? undefined : ["1", "true", "yes"].includes(String(s).toLowerCase());
}, z.boolean().optional());

export const UserOptionsQuerySchema = z.object({
  /** One or more roles (`role=editor`, `role=editor,manager`, `role=a&role=b`). */
  role: z.preprocess(toList, z.array(z.enum(ROLES)).optional()),
  /** Only people who may view this job (mention autocomplete). */
  jobId: z.preprocess(one, z.string().trim().min(1).max(64).optional()),
  /** Include deactivated people (default: active only). */
  includeInactive: bool,
  /** Leave the actor out (mentions). */
  excludeSelf: bool,
  q: z.preprocess(one, z.string().trim().min(1).max(200).optional()),
});

/** People picker (`user.view`; reduced projection; editors carry workload when the actor may see team workloads). */
export async function getUserOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<UserOption[]> {
  const f = parseInput(UserOptionsQuerySchema, input ?? {});
  const roles = f.role && f.role.length > 0 ? new Set(f.role) : null;
  let people: UserRef[] = (
    await listUsers(db, ctx, {
      role: roles && roles.size === 1 ? [...roles][0] : undefined,
      active: f.includeInactive ? undefined : "1",
      q: f.q,
    })
  ).map((u) => ({ id: u.id, name: u.name, role: u.role, avatarColour: u.avatarColour, isActive: u.isActive }));
  if (roles) people = people.filter((u) => roles.has(u.role));
  if (f.excludeSelf && ctx.userId) people = people.filter((u) => u.id !== ctx.userId);

  if (f.jobId) {
    // 404 when the actor cannot see the job (existence never leaks).
    const { ref } = await loadVisibleJob(db, ctx, f.jobId);
    const viewers: UserRef[] = [];
    for (const u of people) {
      if (u.isActive && (await userCanViewJob(db, ctx, u.id, ref))) viewers.push(u);
    }
    people = viewers;
  }

  const editorIds = people.filter((u) => u.role === "editor").map((u) => u.id);
  const workloads = new Map<string, UserOption["workload"]>();
  if (editorIds.length > 0 && canViewTeamWorkloads(ctx)) {
    for (const row of (await computeWorkloads(db, ctx, { editorIds })).rows) {
      workloads.set(row.editor.id, { band: row.band, active: row.active, overdue: row.overdue });
    }
  }
  return people.map((u) => ({ ...u, workload: workloads.get(u.id) ?? null }));
}

/** Non-archived clients the actor can see (`client.view`; editors: clients of visible jobs). */
export async function getClientOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ClientOption[]> {
  const q = input && typeof input === "object" ? (input as Record<string, unknown>).q : undefined;
  return (await listClients(db, ctx, { q })).map((c) => ({ id: c.client.id, name: c.client.name, colour: c.client.colour }));
}

/** Non-archived projects (optionally of one client) the actor can see (`project.view`). */
export async function getProjectOptions(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<ProjectOption[]> {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return (await listProjects(db, ctx, { clientId: o.clientId, q: o.q })).map((p) => ({

    id: p.project.id,
    name: p.project.name,
    clientId: p.project.clientId,
    clientName: p.client.name,
  }));
}
