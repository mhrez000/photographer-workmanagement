import type { Metadata } from "next";
import { PortalNotifications } from "@/components/portal/portal-notifications";
import { load, portalPageContext } from "@/server/page";
import { listPortalNotifications } from "@/server/queries/portal";

export const metadata: Metadata = { title: "Notifications" };

/** /portal/notifications — work shared, work delivered, studio replies (in-app only, docs/ROLES.md §7.6). */
export default async function PortalNotificationsPage() {
  const { ctx, db } = await portalPageContext();
  const items = await load(() => listPortalNotifications(db, ctx));
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Notifications</h1>
        <p className="mt-1 text-sm text-ink-secondary">Updates from your studio about the work they share with you.</p>
      </header>
      <PortalNotifications items={items} timeZone={ctx.settings.timezone} />
    </div>
  );
}
