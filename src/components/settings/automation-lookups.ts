import "server-only";
import type { PageContext } from "@/server/page";
import { getClientOptions } from "@/server/queries/options";
import { listUsers } from "@/server/queries/users";
import { listJobTypes } from "@/server/queries/workflows";
import type { NameLookup } from "./automation-describe";

/** People, job types and clients by id — for automation sentences and pickers. */
export async function loadAutomationLookups(db: PageContext["db"], ctx: PageContext["ctx"]) {
  const users = (await listUsers(db, ctx, {})).map((u) => ({ id: u.id, name: u.name, role: u.role, avatarColour: u.avatarColour, isActive: u.isActive }));
  const jobTypes = (await listJobTypes(db, ctx, { includeArchived: true })).map((t) => ({ id: t.id, name: t.name, colour: t.colour, archived: t.archivedAt !== null }));
  const clients = await getClientOptions(db, ctx, {});
  const lookup: NameLookup = {
    users: Object.fromEntries(users.map((u) => [u.id, u.name])),
    jobTypes: Object.fromEntries(jobTypes.map((t) => [t.id, t.name])),
    clients: Object.fromEntries(clients.map((c) => [c.id, c.name])),
  };
  return { users, jobTypes, clients, lookup };
}
