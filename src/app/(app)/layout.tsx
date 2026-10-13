import * as React from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AppShell } from "@/components/shell";
import { CommandPaletteMount } from "@/components/search/command-palette";
import { getDb } from "@/db";
import { getOptionalContext, getViewer } from "@/server/auth/session";
import { navGatesFor } from "@/server/nav-gates";
import { PORTAL_HOME_PATH } from "@/server/page";
import { countSimpleRows, stageWhere } from "@/server/queries/jobsSimple";
import { unreadCount } from "@/server/services/notifications";
import { lazySweep } from "@/server/services/sweep";

/**
 * Authenticated STAFF app chrome (docs/SIMPLIFICATION-PLAN.md §3). A missing /
 * stale / revoked session redirects to /login?expired=1 (the proxy then drops the
 * dead cookie, avoiding a loop). Client users never render the staff shell: they
 * are sent to /portal (the security boundary is `requireContext()` /
 * `pageContext()`, this is the UX redirect).
 *
 * Navigation gates are computed here with `can()` so the sidebar, the (+) New job
 * button, the phone tabs and the command palette match the viewer's role. The
 * phone Home tab carries the red "to check" count (jobs in Ready to check that
 * the viewer can see). There is no scope switch any more.
 *
 * Lazy sweep (ARCHITECTURE.md §8): after the response is sent, run the overdue
 * sweep for the org when it is due. It never blocks or breaks rendering.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOptionalContext();
  const viewer = ctx ? await getViewer() : null;
  if (!ctx || !viewer) redirect("/login?expired=1");
  if (ctx.role === "client") redirect(PORTAL_HOME_PATH);

  const navGates = navGatesFor(ctx);
  const db = getDb();
  // Editors have no Home tab, so the count is only computed for photographers.
  const toCheckCount = navGates.photographer ? await countSimpleRows(db, ctx, stageWhere("ready_to_check")) : 0;

  const organisationId = ctx.organisationId;
  try {
    after(async () => {
      await lazySweep(organisationId);
    });
  } catch {
    // No request scope (e.g. prerender): skip; the next request sweeps.
  }

  return (
    <AppShell
      user={{
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        role: viewer.role,
        isAdmin: viewer.isAdmin,
        title: viewer.title,
        avatarColour: viewer.avatarColour,
      }}
      orgName={viewer.organisationName}
      unreadCount={await unreadCount(ctx, db)}
      logoutAction="/api/auth/logout"
      navGates={navGates}
      toCheckCount={toCheckCount}
    >
      {children}
      <CommandPaletteMount gates={navGates} />
    </AppShell>
  );
}
