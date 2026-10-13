import { advancedPageContext, guard, load } from "@/server/page";
import { getProjectDetail } from "@/server/queries/projects";

/** Existence + visibility gate above the loading boundary, so a missing or hidden project gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/projects/[id]">) {
  const { id } = await params;
  const { ctx, db } = await advancedPageContext("projects", "/jobs"); // Advanced gate before any query (see src/server/page.ts)
  guard(ctx, "project.view");
  await load(() => getProjectDetail(db, ctx, decodeURIComponent(id)));
  return children;
}
