/**
 * Clients service (ARCHITECTURE.md §2.2, §3.2, §5 client.*).
 *
 * - create: owner / manager / photographer
 * - edit: owner / manager any; photographer only clients they created
 * - archive / restore: owner / manager; archive is blocked while the client
 *   has active (non-terminal) jobs. Archived clients cannot receive new
 *   projects (and therefore no new jobs).
 */
import { and, count, eq, inArray } from "drizzle-orm";
import { clients, jobs } from "@/db/schema";
import { CATEGORY_GROUPS, type Action } from "@/lib/constants";
import type { AuthContext, Client } from "@/lib/types";
import { ArchiveClientInput, CreateClientInput, UpdateClientInput } from "@/lib/validation/clients";
import { recordEvent } from "@/server/audit";
import { assertCan, roleCanEver, type OrgResourceRef } from "@/server/auth/permissions";
import { ForbiddenError } from "@/server/errors";
import { first, loadClientInOrg, one, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation } from "./_admin";

const EDITABLE = ["name", "contactName", "email", "phone", "notes", "colour"] as const;

/** Coarse role gate before parsing (the scoped check runs once the row is loaded). */
export function assertRoleMayEver(ctx: AuthContext, action: Action): void {
  if (!roleCanEver(ctx.role, action)) throw new ForbiddenError(action);
}

export function clientResourceRef(row: Client): OrgResourceRef {
  return { organisationId: row.organisationId, createdByUserId: row.createdByUserId ?? undefined };
}

/** Number of jobs on this client in an ACTIVE (non-terminal) category. */
export async function activeJobCountForClient(db: DbLike, ctx: AuthContext, clientId: string): Promise<number> {
  const row = await first(
    db
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.clientId, clientId), inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]))),
  );
  return row?.n ?? 0;
}

export async function createClient(tx: Tx, ctx: AuthContext, input: unknown): Promise<Client> {
  assertCan(ctx, "client.create");
  const data = parseInput(CreateClientInput, input);
  const now = ctx.now();
  const row = await one(
    tx
      .insert(clients)
      .values({
        organisationId: ctx.organisationId,
        name: data.name,
        contactName: data.contactName ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        notes: data.notes ?? null,
        ...(data.colour ? { colour: data.colour } : {}),
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "client",
    entityId: row.id,
    eventType: "client.created",
    action: "created",
    previousValue: null,
    newValue: { name: row.name, contactName: row.contactName, email: row.email, phone: row.phone, colour: row.colour },
    metadata: { clientId: row.id },
  });
  return row;
}

export async function updateClient(tx: Tx, ctx: AuthContext, input: unknown): Promise<Client> {
  assertRoleMayEver(ctx, "client.edit");
  const data = parseInput(UpdateClientInput, input);
  const client = await loadClientInOrg(tx, ctx, data.clientId);
  assertCan(ctx, "client.edit", clientResourceRef(client));
  checkVersion(client, data.expectedVersion, client);

  const diff = diffFields(client, data, EDITABLE);
  if (diff.changed.length === 0) return client;
  const row = await one(
    tx
      .update(clients)
      .set({ ...diff.set, updatedAt: ctx.now(), version: client.version + 1 })
      .where(eq(clients.id, client.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "client",
    entityId: client.id,
    eventType: "client.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { clientId: client.id, name: row.name },
  });
  return row;
}

export async function archiveClient(tx: Tx, ctx: AuthContext, input: unknown): Promise<Client> {
  assertCan(ctx, "client.archive");
  const data = parseInput(ArchiveClientInput, input);
  const client = await loadClientInOrg(tx, ctx, data.clientId);
  assertCan(ctx, "client.archive", clientResourceRef(client));
  checkVersion(client, data.expectedVersion, client);
  if (client.archivedAt) throw ruleViolation("This client is already archived");
  const active = await activeJobCountForClient(tx, ctx, client.id);
  if (active > 0) {
    throw ruleViolation(`This client has ${active} active job${active === 1 ? "" : "s"}. Complete or cancel them before archiving.`, {
      activeJobCount: active,
    });
  }
  const now = ctx.now();
  const row = await one(
    tx
      .update(clients)
      .set({ archivedAt: now, updatedAt: now, version: client.version + 1 })
      .where(eq(clients.id, client.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "client",
    entityId: client.id,
    eventType: "client.archived",
    action: "archived",
    previousValue: { archivedAt: null },
    newValue: { archivedAt: now },
    metadata: { clientId: client.id, name: client.name },
  });
  return row;
}

export async function restoreClient(tx: Tx, ctx: AuthContext, input: unknown): Promise<Client> {
  assertCan(ctx, "client.archive");
  const data = parseInput(ArchiveClientInput, input);
  const client = await loadClientInOrg(tx, ctx, data.clientId);
  assertCan(ctx, "client.archive", clientResourceRef(client));
  checkVersion(client, data.expectedVersion, client);
  if (!client.archivedAt) throw ruleViolation("This client is not archived");
  const row = await one(
    tx
      .update(clients)
      .set({ archivedAt: null, updatedAt: ctx.now(), version: client.version + 1 })
      .where(eq(clients.id, client.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "client",
    entityId: client.id,
    eventType: "client.restored",
    action: "restored",
    previousValue: { archivedAt: client.archivedAt },
    newValue: { archivedAt: null },
    metadata: { clientId: client.id, name: client.name },
  });
  return row;
}
