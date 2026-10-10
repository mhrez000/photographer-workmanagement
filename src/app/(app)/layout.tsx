import * as React from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AppShell } from "@/components/shell";
import { CommandPaletteMount } from "@/components/search/command-palette";
import { getOptionalContext, getViewer } from "@/server/auth/session";
import { navGatesFor } from "@/server/nav-gates";
import { resolveScope } from "@/server/view-scope";
import { unreadCount } from "@/server/services/notifications";
import { lazySweep } from "@/server/services/sweep";

/**
 * Authenticated STAFF app chrome. A missing/stale/revoked session redirects to
 * /login?expired=1 (the proxy then drops the dead cookie, avoiding a loop).
 * Client users never render the staff shell: they are sent to /portal
 * (docs/ROLES.md §7.8 — the security boundary is `requireContext()` /
 * `pageContext()`, this is the UX redirect).
 *
 * Navigation gates (docs/ROLES.md §10) are computed here with `can()` so the
 * sidebar, quick actions and command palette match the viewer's persona and
 * switches. The scope switch (§8) gets the cookie-resolved scope (a page's
 * `?scope=` override is not reflected in the topbar; pages show it in their header).
 *
 * Lazy sweep (ARCHITECTURE.md §8): after the response is sent, run the
 * overdue / workload sweep for the org when it is due (at most once per
 * SWEEP_MIN_INTERVAL_MINUTES). It never blocks or breaks rendering.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOptionalContext();
  const viewer = ctx ? await getViewer() : null;
  if (!ctx || !viewer) redirect("/login?expired=1");
  if (ctx.role === "client") redirect("/portal");

  const navGates = navGatesFor(ctx);
  // "My shoots | Whole business" (docs/ROLES.md §8): null for viewers without view.business_scope.
  const viewScope = await resolveScope(ctx);

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
      unreadCount={await unreadCount(ctx)}
      logoutAction="/api/auth/logout"
      navGates={navGates}
      viewScope={viewScope}
    >
      {children}
      <CommandPaletteMount gates={navGates} />
    </AppShell>
  );
}
