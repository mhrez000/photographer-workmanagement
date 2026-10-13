/**
 * Organisation settings service (ARCHITECTURE.md §2.1, §5 settings.updated;
 * docs/ROLES.md §1.2, §1.5, §4.3).
 * View and change: admins (`settings.view` / `settings.manage`). One
 * `settings.updated` event per changed field (`{field, value}` before/after).
 * Not editable here: `last_overdue_sweep_at` (audit exemption, written by the
 * sweep), `primary_owner_user_id` (`transferPrimaryOwner` in services/users.ts),
 * `roles_v2_notice_dismissed_at` (`dismissRolesNotice`) and the four deprecated
 * org-wide visibility switches (roles v2: per-user switches).
 * `advanced_tools_enabled` (SIMPLIFICATION-PLAN §8) IS editable here (admins; audited like every
 * field); `setAdvancedTools` in ./simple.ts is the thin wrapper the Studio page calls.
 */
import { and, eq } from "drizzle-orm";
import { organisationSettings, organisations, users } from "@/db/schema";
import type { AuthContext, Organisation, OrganisationSettings } from "@/lib/types";
import { DismissRolesNoticeInput, SETTINGS_FIELDS, UpdateSettingsInput } from "@/lib/validation/settings";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { first, parseInput, type DbLike, type Tx } from "./_shared";
import { UserRuleError, checkVersion, ruleViolation } from "./_admin";

export interface SettingsView {
  organisation: Pick<Organisation, "id" | "name" | "slug">;
  settings: OrganisationSettings;
}

async function loadSettingsRow(db: DbLike, ctx: AuthContext): Promise<SettingsView> {
  const org = await first(db.select().from(organisations).where(eq(organisations.id, ctx.organisationId)));
  if (!org) throw new NotFoundError("Organisation");
  let settings = await first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)));
  if (!settings) {
    // Every org is created with a settings row; this is a defensive fallback with column defaults.
    settings = { ...defaultSettingsRow(ctx.organisationId) };
  }
  return { organisation: { id: org.id, name: org.name, slug: org.slug }, settings };
}

function defaultSettingsRow(organisationId: string): OrganisationSettings {
  return {
    organisationId,
    timezone: "Australia/Sydney",
    weekStartsOn: 1,
    jobNumberPrefix: "PJ",
    timeTrackingEnabled: false,
    workSessionAutoTimeoutMinutes: 600,
    defaultCapacityHoursPerWeek: 38,
    defaultEstimatedHours: 2,
    workloadNearCapacityRatio: 0.7,
    workloadOverloadedRatio: 1,
    maxActiveJobsPerEditor: 12,
    reviewBottleneckHours: 24,
    reviewBottleneckMinJobs: 3,
    editingBottleneckDueWithinHours: 48,
    editingBottleneckMinDueSoon: 3,
    unassignedBacklogMin: 10,
    stalledDays: 5,
    revisionSpikeMinCount: 5,
    revisionSpikeMultiplier: 1.5,
    reviewSlaHours: 24,
    photographersSeeAllJobs: false,
    photographersSeeTeamJobs: true,
    editorsSeeTeamJobs: false,
    editorsSeeTeamWorkloads: false,
    automationsEnabled: true,
    auditNotifications: false,
    primaryOwnerUserId: null,
    defaultPhotographerUserId: null,
    rolesV2NoticeDismissedAt: null,
    lastOverdueSweepAt: null,
    advancedToolsEnabled: false,
    updatedAt: new Date(0).toISOString(),
    version: 0,
  };
}

/** Organisation + settings row (admins). */
export async function getSettings(db: DbLike, ctx: AuthContext): Promise<SettingsView> {
  assertCan(ctx, "settings.view");
  return loadSettingsRow(db, ctx);
}

export interface UpdateSettingsResult extends SettingsView {
  changedFields: string[];
}

/**
 * The default photographer for jobs editors create (§4.3): an ACTIVE
 * photographer of the organisation (allow-list, §3.4), else 422.
 */
async function assertDefaultPhotographer(db: DbLike, ctx: AuthContext, userId: string): Promise<{ id: string; name: string }> {
  const row = await first(
    db
      .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("User");
  if (row.role !== "photographer" || !row.isActive) {
    throw new UserRuleError("invalid_target", "Choose an active photographer", "defaultPhotographerUserId");
  }
  return { id: row.id, name: row.name };
}

async function userName(db: DbLike, userId: unknown): Promise<string | null> {
  if (typeof userId !== "string") return null;
  return (await first(db.select({ name: users.name }).from(users).where(eq(users.id, userId))))?.name ?? null;
}

/** Admins only. Writes only the fields that changed, one event per field. */
export async function updateSettings(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateSettingsResult> {
  assertCan(ctx, "settings.manage");
  const data = parseInput(UpdateSettingsInput, input);
  const current = await loadSettingsRow(tx, ctx);
  const row = current.settings;
  if (row.version > 0) checkVersion(row, data.expectedVersion, current);

  const changes: { field: string; previous: unknown; next: unknown }[] = [];
  const set: Partial<OrganisationSettings> = {};
  for (const field of SETTINGS_FIELDS) {
    const value = data[field];
    if (value === undefined || value === row[field]) continue;
    changes.push({ field, previous: row[field], next: value });
    (set as Record<string, unknown>)[field] = value;
  }
  if (typeof set.defaultPhotographerUserId === "string") await assertDefaultPhotographer(tx, ctx, set.defaultPhotographerUserId);
  const near = (set.workloadNearCapacityRatio ?? row.workloadNearCapacityRatio) as number;
  const over = (set.workloadOverloadedRatio ?? row.workloadOverloadedRatio) as number;
  if (near >= over) {
    throw ruleViolation("The near-capacity ratio must be below the overloaded ratio", {}, "workloadNearCapacityRatio");
  }
  const renamed = data.organisationName !== undefined && data.organisationName !== current.organisation.name;
  if (changes.length === 0 && !renamed) return { ...current, changedFields: [] };

  const now = ctx.now();
  if (changes.length > 0) {
    if (row.version === 0) {
      await tx.insert(organisationSettings).values({ ...row, ...set, updatedAt: now, version: 1 });
    } else {
      await tx
        .update(organisationSettings)
        .set({ ...set, updatedAt: now, version: row.version + 1 })
        .where(eq(organisationSettings.organisationId, ctx.organisationId));
    }
  }
  if (renamed) {
    await tx.update(organisations).set({ name: data.organisationName, updatedAt: now }).where(eq(organisations.id, ctx.organisationId));
    changes.unshift({ field: "organisationName", previous: current.organisation.name, next: data.organisationName });
  }
  for (const c of changes) {
    const names =
      c.field === "defaultPhotographerUserId" ? { previousName: await userName(tx, c.previous), nextName: await userName(tx, c.next) } : {};
    await recordEvent(tx, ctx, {
      entityType: "settings",
      entityId: ctx.organisationId,
      eventType: "settings.updated",
      action: "updated",
      previousValue: { field: c.field, value: c.previous },
      newValue: { field: c.field, value: c.next },
      metadata: { field: c.field, ...names },
    });
  }
  return { ...(await loadSettingsRow(tx, ctx)), changedFields: changes.map((c) => c.field) };
}

/**
 * POST /api/settings/roles-notice/dismiss (admin, §1.5): hides the
 * post-migration card on /settings/users for every admin. Idempotent.
 */
export async function dismissRolesNotice(tx: Tx, ctx: AuthContext, input: unknown): Promise<SettingsView> {
  assertCan(ctx, "settings.manage");
  const data = parseInput(DismissRolesNoticeInput, input ?? {});
  const current = await loadSettingsRow(tx, ctx);
  const row = current.settings;
  if (row.version === 0) throw new NotFoundError("Organisation settings");
  checkVersion(row, data.expectedVersion, current);
  if (row.rolesV2NoticeDismissedAt !== null) return current;
  const now = ctx.now();
  await tx
    .update(organisationSettings)
    .set({ rolesV2NoticeDismissedAt: now, updatedAt: now, version: row.version + 1 })
    .where(eq(organisationSettings.organisationId, ctx.organisationId));
  await recordEvent(tx, ctx, {
    entityType: "settings",
    entityId: ctx.organisationId,
    eventType: "settings.updated",
    action: "updated",
    previousValue: { field: "rolesV2NoticeDismissedAt", value: null },
    newValue: { field: "rolesV2NoticeDismissedAt", value: now },
    metadata: { field: "rolesV2NoticeDismissedAt" },
  });
  return loadSettingsRow(tx, ctx);
}
