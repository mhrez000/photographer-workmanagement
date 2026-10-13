import { pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * The Timeline is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): while Settings → Studio →
 * Advanced tools is off, /workspace/timeline 307s to Jobs. The gate lives in the layout, above
 * the loading boundary, so the redirect is real and never a streamed 200.
 */
export default async function TimelineLayout({ children }: LayoutProps<"/workspace/timeline">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "timeline", "/jobs");
  return children;
}
