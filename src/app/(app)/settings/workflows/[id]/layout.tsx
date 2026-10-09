import { guard, load, pageContext } from "@/server/page";
import { getWorkflowGraph } from "@/server/queries/workflows";

/** Existence + visibility gate above the loading boundary, so a missing or hidden workflow gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/settings/workflows/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "workflow.view");
  load(() => getWorkflowGraph(db, ctx, decodeURIComponent(id)));
  return children;
}
