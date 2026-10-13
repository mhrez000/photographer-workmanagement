import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): while Settings → Studio → Advanced tools is off this page
 * redirects to /settings/people. The permission gate sits above the loading boundary so a denied request gets a real 403.
 */
export default async function Layout({ children }: LayoutProps<"/settings/roles">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "permissions", "/settings/people");
  guard(ctx, "settings.view");
  return children;
}
