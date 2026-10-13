import { pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * The Board is an Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): while Settings → Studio →
 * Advanced tools is off, /workspace/kanban 307s to Jobs. The gate lives in the layout, above the
 * loading boundary, so the redirect is real and never a streamed 200.
 */
export default async function KanbanLayout({ children }: LayoutProps<"/workspace/kanban">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "kanban", "/jobs");
  return children;
}
