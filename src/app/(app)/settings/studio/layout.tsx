import { guard, pageContext } from "@/server/page";

/** Permission gate above this segment's loading boundary, so a denied request gets a real 403 status. */
export default async function Layout({ children }: LayoutProps<"/settings/studio">) {
  const { ctx } = await pageContext();
  guard(ctx, "settings.view");
  return children;
}
