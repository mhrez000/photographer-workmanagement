import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Bottlenecks is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): while the studio's switch is off the
 * old address goes to Editors. Both gates sit above the loading boundary (real redirect / 403).
 */
export default async function Layout({ children }: LayoutProps<"/insights/bottlenecks">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "bottlenecks", "/editors");
  guard(ctx, "bottlenecks.view");
  return children;
}
