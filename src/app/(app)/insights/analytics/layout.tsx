import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Reports & stats is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): while the studio's switch is off
 * the old address goes to Editors. Both gates sit above the loading boundary (real redirect / 403).
 */
export default async function Layout({ children }: LayoutProps<"/insights/analytics">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "analytics", "/editors");
  guard(ctx, "analytics.view");
  return children;
}
