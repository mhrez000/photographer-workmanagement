import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Reports is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §7, §8; the old "on time" formula lives here).
 * While the studio's switch is off the old address goes to Editors. Gates above the loading boundary.
 */
export default async function Layout({ children }: LayoutProps<"/insights/reports">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "reports", "/editors");
  guard(ctx, "reports.view");
  return children;
}
