import { guard, load, pageContext } from "@/server/page";
import { getProjectDetail } from "@/server/queries/projects";

/** Existence + visibility gate above the loading boundary, so a missing or hidden project gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/projects/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "project.view");
  load(() => getProjectDetail(db, ctx, decodeURIComponent(id)));
  return children;
}
