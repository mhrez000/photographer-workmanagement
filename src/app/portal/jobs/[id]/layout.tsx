import { load, portalPageContext } from "@/server/page";
import { loadPortalJob } from "@/server/queries/portal";

/**
 * Visibility gate ABOVE the loading boundary so a job outside the client's
 * portal (unshared, another client's, foreign, cancelled > 30 days) gets a
 * real 404 status, never 403 (docs/ROLES.md §7.2).
 */
export default async function PortalJobLayout({ children, params }: LayoutProps<"/portal/jobs/[id]">) {
  const { id } = await params;
  const { ctx, db } = await portalPageContext();
  await load(() => loadPortalJob(db, ctx, decodeURIComponent(id)));
  return children;
}
