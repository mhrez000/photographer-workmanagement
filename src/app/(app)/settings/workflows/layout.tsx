import { guard, pageContext } from "@/server/page";

/** Permission gate above this segment's loading boundary, so a denied request gets a real 403 status. */
export default async function Layout({ children }: LayoutProps<"/settings/workflows">) {
  const { ctx } = await pageContext();
  guard(ctx, "workflow.view");
  return children;
}
