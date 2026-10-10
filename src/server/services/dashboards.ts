/**
 * Dashboard layouts (ARCHITECTURE.md §2.5 dashboard_layouts, §10 /dashboard,
 * §5 dashboard.updated). One row per user; no row = the role default.
 * Widgets a role may not see (e.g. editor_performance for an editor) are
 * rejected on save, so a stored layout never asks for data the user cannot
 * load.
 */
import { and, eq } from "drizzle-orm";
import { dashboardLayouts } from "@/db/schema";
import type { DashboardWidgetType, Role } from "@/lib/constants";
import type { AuthContext, DashboardLayout } from "@/lib/types";
import { DashboardLayoutSchema, parseJsonColumn } from "@/lib/validation/json";
import { PutDashboardLayoutInput } from "@/lib/validation/views";
import { recordEvent } from "@/server/audit";
import { assertCan, can } from "@/server/auth/permissions";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { first, one, parseInput, type DbLike, type Tx } from "./_shared";
import { ruleViolation } from "./_admin";

type Widget = DashboardLayout["widgets"][number];

const w = (id: string, type: DashboardWidgetType, x: number, y: number, width: number, h: number): Widget => ({ id, type, x, y, w: width, h });

const MANAGEMENT_LAYOUT: DashboardLayout = {
  widgets: [
    w("kpis", "kpis", 0, 0, 12, 2),
    w("bottlenecks", "bottlenecks", 0, 2, 12, 2),
    w("team_workload", "team_workload", 0, 4, 8, 4),
    w("due_today", "due_today", 8, 4, 4, 4),
    w("overdue", "overdue", 0, 8, 6, 4),
    w("recent_activity", "recent_activity", 6, 8, 6, 4),
    w("editor_performance", "editor_performance", 0, 12, 6, 4),
    w("revision_rate", "revision_rate", 6, 12, 3, 4),
    w("completion_rate", "completion_rate", 9, 12, 3, 4),
    w("recent_completed", "recent_completed", 0, 16, 12, 4),
  ],
};

const PHOTOGRAPHER_LAYOUT: DashboardLayout = {
  widgets: [
    w("kpis", "kpis", 0, 0, 12, 2),
    w("my_workload", "my_workload", 0, 2, 6, 4),
    w("my_performance", "my_performance", 6, 2, 6, 4),
    w("due_today", "due_today", 0, 6, 6, 4),
    w("overdue", "overdue", 6, 6, 6, 4),
    w("recent_activity", "recent_activity", 0, 10, 8, 4),
    w("calendar", "calendar", 8, 10, 4, 4),
    w("recent_completed", "recent_completed", 0, 14, 12, 4),
  ],
};

const EDITOR_LAYOUT: DashboardLayout = {
  widgets: [
    w("kpis", "kpis", 0, 0, 12, 2),
    w("my_workload", "my_workload", 0, 2, 6, 3),
    w("my_performance", "my_performance", 6, 2, 6, 3),
    w("due_today", "due_today", 0, 5, 6, 4),
    w("overdue", "overdue", 6, 5, 6, 4),
    w("recent_activity", "recent_activity", 0, 9, 8, 4),
    w("calendar", "calendar", 8, 9, 4, 4),
  ],
};

/** Default layout for a role (deep copy). */
export function defaultLayoutFor(role: Role): DashboardLayout {
  const base = role === "owner" || role === "manager" ? MANAGEMENT_LAYOUT : role === "photographer" ? PHOTOGRAPHER_LAYOUT : EDITOR_LAYOUT;
  return { widgets: base.widgets.map((x) => ({ ...x })) };
}

/** Widget types this actor may place (data behind each widget must be visible to them). */
export function allowedWidgetTypes(ctx: AuthContext): Set<DashboardWidgetType> {
  const allowed = new Set<DashboardWidgetType>([
    "kpis",
    "my_workload",
    "due_today",
    "overdue",
    "recent_activity",
    "calendar",
    "recent_completed",
    "my_performance",
  ]);
  if (can(ctx, "workloads.view_team")) allowed.add("team_workload");
  if (can(ctx, "performance.view")) allowed.add("editor_performance");
  if (can(ctx, "analytics.view")) {
    allowed.add("completion_rate");
    allowed.add("revision_rate");
  }
  if (can(ctx, "bottlenecks.view")) allowed.add("bottlenecks");
  return allowed;
}

export interface DashboardLayoutView {
  layout: DashboardLayout;
  /** 0 when no row exists yet (role default). */
  version: number;
  isDefault: boolean;
}

function actorOf(ctx: AuthContext): string {
  if (!ctx.userId || ctx.isSystem) throw new ForbiddenError("dashboard.customise");
  return ctx.userId;
}

/** The actor's layout, or the role default (filtered to widgets they may see). */
export async function getDashboardLayout(db: DbLike, ctx: AuthContext): Promise<DashboardLayoutView> {
  const me = actorOf(ctx);
  assertCan(ctx, "dashboard.customise", { userId: me, organisationId: ctx.organisationId });
  const allowed = allowedWidgetTypes(ctx);
  const row = await first(
    db
      .select()
      .from(dashboardLayouts)
      .where(and(eq(dashboardLayouts.userId, me), eq(dashboardLayouts.organisationId, ctx.organisationId))),
  );
  const fallback = defaultLayoutFor(ctx.role);
  const layout = row ? parseJsonColumn(DashboardLayoutSchema, row.layout, fallback) : fallback;
  return {
    layout: { widgets: layout.widgets.filter((x) => allowed.has(x.type)) },
    version: row?.version ?? 0,
    isDefault: !row,
  };
}

/** Saves the actor's layout (upsert). `expectedVersion` 0 = "no row yet". */
export async function putDashboardLayout(tx: Tx, ctx: AuthContext, input: unknown): Promise<DashboardLayoutView> {
  const me = actorOf(ctx);
  assertCan(ctx, "dashboard.customise", { userId: me, organisationId: ctx.organisationId });
  const data = parseInput(PutDashboardLayoutInput, input);
  const allowed = allowedWidgetTypes(ctx);
  const forbidden = Array.from(new Set(data.layout.widgets.map((x) => x.type).filter((t) => !allowed.has(t))));
  if (forbidden.length > 0) throw ruleViolation(`These widgets are not available to you: ${forbidden.join(", ")}`, { forbidden }, "layout");

  const row = await first(tx.select().from(dashboardLayouts).where(eq(dashboardLayouts.userId, me)));
  if (data.expectedVersion !== undefined && (row?.version ?? 0) !== data.expectedVersion) {
    throw new ConflictError(undefined, row ? { layout: row.layout, version: row.version } : { layout: defaultLayoutFor(ctx.role), version: 0 });
  }
  const now = ctx.now();
  const previous = row ? row.layout : null;
  const saved = row
    ? await one(
        tx
          .update(dashboardLayouts)
          .set({ layout: data.layout, updatedAt: now, version: row.version + 1 })
          .where(eq(dashboardLayouts.id, row.id))
          .returning(),
      )
    : await one(tx.insert(dashboardLayouts).values({ organisationId: ctx.organisationId, userId: me, layout: data.layout, updatedAt: now }).returning());
  await recordEvent(tx, ctx, {
    entityType: "dashboard",
    entityId: saved.id,
    eventType: "dashboard.updated",
    action: row ? "updated" : "created",
    previousValue: previous ? { layout: previous } : null,
    newValue: { layout: data.layout },
    metadata: { widgetCount: data.layout.widgets.length },
  });
  return { layout: saved.layout, version: saved.version, isDefault: false };
}

/** Restores the role default (saved as the user's row so the change is audited). */
export async function resetDashboardLayout(tx: Tx, ctx: AuthContext): Promise<DashboardLayoutView> {
  const allowed = allowedWidgetTypes(ctx);
  const layout = defaultLayoutFor(ctx.role);
  return putDashboardLayout(tx, ctx, { layout: { widgets: layout.widgets.filter((x) => allowed.has(x.type)) } });
}
