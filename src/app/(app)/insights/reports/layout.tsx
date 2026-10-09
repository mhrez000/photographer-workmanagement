import { guard, pageContext } from "@/server/page";

/** Permission gate above the loading boundary, so a denied request gets a real 403 status. */
export default async function Layout({ children }: LayoutProps<"/insights/reports">) {
  const { ctx } = await pageContext();
  guard(ctx, "reports.view");
  return children;
}
