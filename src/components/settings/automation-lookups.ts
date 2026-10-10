import "server-only";
import type { PageContext } from "@/server/page";
import { getClientOptions } from "@/server/queries/options";
import { listUsers } from "@/server/queries/users";
import { listJobTypes } from "@/server/queries/workflows";
import type { NameLookup } from "./automation-describe";

/** People, job types and clients by id — for automation sentences and pickers. */
export async function loadAutomationLookups(db: PageContext["db"], ctx: PageContext["ctx"]) {
  // Staff only: automation assign / notify "user" targets must be photographers or editors (docs/ROLES.md §3.4).
  const users = (await listUsers(db, ctx, {}))
    .filter((u) => u.role !== "client")
    .map((u) => ({ id: u.id, name: u.name, role: u.role, avatarColour: u.avatarColour, isActive: u.isActive, isAdmin: u.isAdmin }));
  const jobTypes = (await listJobTypes(db, ctx, { includeArchived: true })).map((t) => ({ id: t.id, name: t.name, colour: t.colour, archived: t.archivedAt !== null }));
  const clients = await getClientOptions(db, ctx, {});
  const lookup: NameLookup = {
    users: Object.fromEntries(users.map((u) => [u.id, u.name])),
    jobTypes: Object.fromEntries(jobTypes.map((t) => [t.id, t.name])),
    clients: Object.fromEntries(clients.map((c) => [c.id, c.name])),
  };
  return { users, jobTypes, clients, lookup };
}
