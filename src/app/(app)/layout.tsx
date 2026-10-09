import * as React from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AppShell } from "@/components/shell";
import { CommandPaletteMount } from "@/components/search/command-palette";
import type { NavGrants } from "@/config/nav";
import { can } from "@/server/auth/permissions";
import { getOptionalContext, getViewer } from "@/server/auth/session";
import { unreadCount } from "@/server/services/notifications";
import { lazySweep } from "@/server/services/sweep";
import { canViewTeamWork } from "./workspace/team/access";

/**
 * Authenticated app chrome. A missing/stale/revoked session redirects to
 * /login?expired=1 (the proxy then drops the dead cookie, avoiding a loop).
 *
 * Lazy sweep (ARCHITECTURE.md §8): after the response is sent, run the
 * overdue / workload sweep for the org when it is due (at most once per
 * SWEEP_MIN_INTERVAL_MINUTES). It never blocks or breaks rendering.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOptionalContext();
  const viewer = ctx ? await getViewer() : null;
  if (!ctx || !viewer) redirect("/login?expired=1");

  // Flag-based access beyond the role defaults (ARCHITECTURE §3.2), so e.g. a
  // photographer with can_view_analytics can reach Insights from the nav.
  const navGrants: NavGrants = {
    analytics: can(ctx, "analytics.view"),
    teamWorkloads: can(ctx, "workloads.view_team"),
    teamWork: canViewTeamWork(ctx),
  };

  const organisationId = ctx.organisationId;
  try {
    after(() => lazySweep(organisationId));
  } catch {
    // No request scope (e.g. prerender): skip; the next request sweeps.
  }

  return (
    <AppShell
      user={{ id: viewer.id, name: viewer.name, email: viewer.email, role: viewer.role, avatarColour: viewer.avatarColour }}
      orgName={viewer.organisationName}
      unreadCount={unreadCount(ctx)}
      logoutAction="/api/auth/logout"
      navGrants={navGrants}
    >
      {children}
      <CommandPaletteMount role={viewer.role} grants={navGrants} />
    </AppShell>
  );
}
