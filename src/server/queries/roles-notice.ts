/**
 * Post-migration notice on /settings/users (docs/ROLES.md §1.5).
 *
 * Shown to admins while `organisation_settings.roles_v2_notice_dismissed_at`
 * is null AND the organisation went through the `0003_roles_v2_data`
 * migration (it wrote audit events with `metadata.migration`). A fresh
 * organisation (seeded or created on v2) never sees it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { activityEvents, organisationSettings, users } from "@/db/schema";
import type { AuthContext } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";

export const ROLES_V2_MIGRATION = "0003_roles_v2_data";

export interface RolesNoticePerson {
  id: string;
  name: string;
  /** users.version — expectedVersion for the admin / permissions calls. */
  version: number;
}

export interface RolesNoticeEditor extends RolesNoticePerson {
  canViewTeamJobs: boolean;
}

export interface RolesNoticeView {
  /** organisation_settings.version — expectedVersion for the dismiss call. */
  settingsVersion: number;
  /** Former managers who are still active team members (not admins). */
  exManagers: RolesNoticePerson[];
  /** Total former managers (incl. those already made admin or deactivated). */
  exManagerCount: number;
  /** Active editors recorded when the org had "editors see team jobs" on (empty when it was off). */
  teamJobEditors: RolesNoticeEditor[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The notice for an admin, or null (dismissed, never migrated, or not an admin). */
export async function getRolesNotice(db: DbLike, ctx: AuthContext): Promise<RolesNoticeView | null> {
  assertCan(ctx, "settings.view");
  const settings = await first(
    db
      .select({ dismissedAt: organisationSettings.rolesV2NoticeDismissedAt, version: organisationSettings.version })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, ctx.organisationId)),
  );
  if (!settings || settings.dismissedAt !== null) return null;

  const events = await db
    .select({ eventType: activityEvents.eventType, entityId: activityEvents.entityId, metadata: activityEvents.metadata })
    .from(activityEvents)
    .where(and(eq(activityEvents.organisationId, ctx.organisationId), sql`${activityEvents.metadata}->>'migration' = ${ROLES_V2_MIGRATION}`));
  if (events.length === 0) return null;

  const managerIds = events
    .filter((e) => e.eventType === "user.role_changed" && e.metadata.formerRole === "manager")
    .map((e) => e.entityId);
  const editorIds = [
    ...new Set(events.filter((e) => e.eventType === "settings.updated").flatMap((e) => stringList(e.metadata.editorIds))),
  ];

  const people = managerIds.length + editorIds.length > 0
    ? await db
        .select({
          id: users.id,
          name: users.name,
          version: users.version,
          role: users.role,
          isAdmin: users.isAdmin,
          isActive: users.isActive,
          canViewTeamJobs: users.canViewTeamJobs,
        })
        .from(users)
        .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, [...managerIds, ...editorIds])))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  const exManagers = managerIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.isActive && p.role === "photographer" && !p.isAdmin)
    .map((p) => ({ id: p.id, name: p.name, version: p.version }))
    .sort(byName);
  const teamJobEditors = editorIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.isActive && p.role === "editor")
    .map((p) => ({ id: p.id, name: p.name, version: p.version, canViewTeamJobs: p.canViewTeamJobs }))
    .sort(byName);

  return { settingsVersion: settings.version, exManagers, exManagerCount: managerIds.length, teamJobEditors };
}
