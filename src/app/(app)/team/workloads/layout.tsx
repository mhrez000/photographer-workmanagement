import { guard, pageContext } from "@/server/page";

/** Permission gate above the loading boundary, so a denied request gets a real 403 status. */
export default async function Layout({ children }: LayoutProps<"/team/workloads">) {
  const { ctx } = await pageContext();
  guard(ctx, "workloads.view_team");
  return children;
}
