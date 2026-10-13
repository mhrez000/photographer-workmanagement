import { forbidden } from "next/navigation";
import { pageContext } from "@/server/page";
import { canSeeEditorsPage } from "@/server/queries/editors";

/**
 * Editors (docs/SIMPLIFICATION-PLAN.md §7) is for the studio owner and co-owners (and a team member with
 * the analytics switch). The gate sits above the loading boundaries of `(list)` and `[id]`, so a refused
 * viewer — an editor, an extra photographer — gets a real 403 status rather than a streamed 200.
 */
export default async function EditorsLayout({ children }: LayoutProps<"/editors">) {
  const { ctx } = await pageContext();
  if (!canSeeEditorsPage(ctx)) forbidden();
  return children;
}
