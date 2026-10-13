import { guard, pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Workloads (capacity hours, estimated hours, bands) is an Advanced tool (docs/SIMPLIFICATION-PLAN.md
 * §8): while the studio's switch is off the old address goes to Editors. Both gates sit above the loading
 * boundary, so the redirect and a denied request's 403 are real statuses.
 */
export default async function Layout({ children }: LayoutProps<"/team/workloads">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "workloads", "/editors");
  guard(ctx, "workloads.view_team");
  return children;
}
