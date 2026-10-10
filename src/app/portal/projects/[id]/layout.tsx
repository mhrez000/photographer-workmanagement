import { load, portalPageContext } from "@/server/page";
import { getPortalProject } from "@/server/queries/portal";

/** Gate above the loading boundary: a project with no job shared with this client is a real 404 (docs/ROLES.md §7.2). */
export default async function PortalProjectLayout({ children, params }: LayoutProps<"/portal/projects/[id]">) {
  const { id } = await params;
  const { ctx, db } = await portalPageContext();
  await load(() => getPortalProject(db, ctx, decodeURIComponent(id)));
  return children;
}
