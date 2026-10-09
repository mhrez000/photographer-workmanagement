import { guard, pageContext } from "@/server/page";

/** Permission gate above the loading boundary, so a denied request gets a real 403 status. */
export default async function Layout({ children }: LayoutProps<"/insights/analytics">) {
  const { ctx } = await pageContext();
  guard(ctx, "analytics.view");
  return children;
}
