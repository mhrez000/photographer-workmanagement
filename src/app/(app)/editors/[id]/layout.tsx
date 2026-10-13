import { load, pageContext } from "@/server/page";
import { loadEditorInOrg } from "@/server/queries/editors";

/**
 * Existence gate above the editor page's loading boundary: an id that is not an editor of this studio
 * gets a real 404 status (not a streamed 200). The 403 gate is the parent `editors/layout.tsx`.
 */
export default async function EditorLayout({ children, params }: LayoutProps<"/editors/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  await load(() => loadEditorInOrg(db, ctx, decodeURIComponent(id)));
  return children;
}
