import * as React from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AppShell } from "@/components/shell";
import { getOptionalContext, getViewer } from "@/server/auth/session";
import { unreadCount } from "@/server/services/notifications";
import { lazySweep } from "@/server/services/sweep";

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
    >
      {children}
    </AppShell>
  );
}
