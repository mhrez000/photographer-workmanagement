/**
 * Dashboard layouts (ARCHITECTURE.md §2.5 dashboard_layouts, §10 /dashboard,
 * §5 dashboard.updated; docs/ROLES.md §9). One row per user; no row = the
 * persona default (admin / team member / editor).
 * Widgets a role may not see (e.g. editor_performance for an editor) are
 * rejected on save, so a stored layout never asks for data the user cannot
 * load.
 */
import { and, eq } from "drizzle-orm";
import { dashboardLayouts } from "@/db/schema";
import type { DashboardWidgetType, Persona, Role } from "@/lib/constants";
import type { AuthContext, DashboardLayout } from "@/lib/types";
import { DashboardLayoutSchema, parseJsonColumn } from "@/lib/validation/json";
import { PutDashboardLayoutInput } from "@/lib/validation/views";
import { recordEvent } from "@/server/audit";
import { assertCan, can, personaOf } from "@/server/auth/permissions";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { first, one, parseInput, type DbLike, type Tx } from "./_shared";
import { ruleViolation } from "./_admin";

type Widget = DashboardLayout["widgets"][number];

const w = (id: string, type: DashboardWidgetType, x: number, y: number, width: number, h: number): Widget => ({ id, type, x, y, w: width, h });

/** Stacks widgets in a 12-column grid in the given order (full / half rows). */
function stack(items: readonly [DashboardWidgetType, number, number][]): DashboardLayout {
  const widgets: Widget[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const [type, width, h] of items) {
    if (x + width > 12) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    widgets.push(w(type, type, x, y, width, h));
    x += width;
    rowH = Math.max(rowH, h);
  }
  return { widgets };
}

/** docs/ROLES.md §9 admin order. */
const ADMIN_LAYOUT: DashboardLayout = stack([
  ["kpis", 12, 2],
  ["my_shoots", 6, 4],
  ["awaiting_review", 6, 4],
  ["questions", 6, 4],
  ["overdue", 6, 4],
  ["upcoming_deadlines", 6, 4],
  ["team_workload", 6, 4],
  ["revisions", 6, 4],
  ["recent_completed", 6, 4],
  ["recent_activity", 6, 4],
  ["turnaround", 6, 4],
  ["bottlenecks", 12, 2],
  ["completion_rate", 4, 4],
  ["revision_rate", 4, 4],
  ["editor_performance", 4, 4],
]);

/** §9 member order (+ flagged widgets: they are filtered out when the switch is off). */
const MEMBER_LAYOUT: DashboardLayout = stack([
  ["kpis", 12, 2],
  ["my_shoots", 6, 4],
  ["awaiting_review", 6, 4],
  ["questions", 6, 4],
  ["due_today", 6, 4],
  ["overdue", 6, 4],
  ["upcoming_deadlines", 6, 4],
  ["revisions", 6, 4],
  ["recent_completed", 6, 4],
  ["my_performance", 6, 4],
  ["recent_activity", 6, 4],
  ["team_workload", 12, 4],
  ["turnaround", 6, 4],
  ["bottlenecks", 6, 4],
]);

/** §9 editor order (the queue preview lives in the KPI / My queue card). */
const EDITOR_LAYOUT: DashboardLayout = stack([
  ["kpis", 12, 2],
  ["due_today", 6, 4],
  ["overdue", 6, 4],
  ["upcoming_deadlines", 6, 4],
  ["my_workload", 6, 3],
  ["my_performance", 6, 3],
  ["recent_completed", 6, 4],
  ["recent_activity", 12, 4],
]);

/** Default layout for a persona (deep copy). Roles map to their base persona (photographer → member). */
export function defaultLayoutFor(who: Persona | Role): DashboardLayout {
  const base = who === "admin" ? ADMIN_LAYOUT : who === "member" || who === "photographer" ? MEMBER_LAYOUT : EDITOR_LAYOUT;
  return { widgets: base.widgets.map((x) => ({ ...x })) };
}

/** Widget types this actor may place (data behind each widget must be visible to them; docs/ROLES.md §9). */
export function allowedWidgetTypes(ctx: AuthContext): Set<DashboardWidgetType> {
  const allowed = new Set<DashboardWidgetType>([
    "kpis",
    "due_today",
    "overdue",
    "upcoming_deadlines",
    "revisions",
    "recent_activity",
    "calendar",
    "recent_completed",
  ]);
  const persona = personaOf(ctx);
  if (persona === "editor") allowed.add("my_workload");
  if (persona === "member" || persona === "editor") allowed.add("my_performance");
  if (persona === "admin" || persona === "member") {
    allowed.add("my_shoots");
    allowed.add("questions");
  }
  if (persona === "admin" || (persona === "member" && ctx.canReviewSubmissions)) allowed.add("awaiting_review");
  if (can(ctx, "workloads.view_team")) allowed.add("team_workload");
  if (can(ctx, "performance.view")) allowed.add("editor_performance");
  if (can(ctx, "analytics.view")) {
    allowed.add("completion_rate");
    allowed.add("revision_rate");
    allowed.add("turnaround");
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
  const fallback = defaultLayoutFor(personaOf(ctx));
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
    throw new ConflictError(undefined, row ? { layout: row.layout, version: row.version } : { layout: defaultLayoutFor(personaOf(ctx)), version: 0 });
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
  const layout = defaultLayoutFor(personaOf(ctx));
  return putDashboardLayout(tx, ctx, { layout: { widgets: layout.widgets.filter((x) => allowed.has(x.type)) } });
}
