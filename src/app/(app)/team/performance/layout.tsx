import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Performance (the old approval-based formulas) is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §7, §8):
 * while the studio's switch is off the old address goes to Editors. Gates above the loading boundary.
 */
export default async function Layout({ children }: LayoutProps<"/team/performance">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "performance", "/editors");
  guard(ctx, "performance.view");
  return children;
}
