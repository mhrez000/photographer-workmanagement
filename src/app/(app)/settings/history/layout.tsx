import { guard, pageContext } from "@/server/page";

/** Settings → History is the studio-wide log for the owner / co-owners (plan §3). Real 403 above the loading boundary. */
export default async function Layout({ children }: LayoutProps<"/settings/history">) {
  const { ctx } = await pageContext();
  guard(ctx, "settings.view");
  guard(ctx, "activity.view_global");
  return children;
}
