import { load, pageContext } from "@/server/page";
import { getAutomationDetail } from "@/server/queries/automations";

/** Existence gate above the loading boundary, so an unknown rule gets a real 404 status ("new" is the builder). */
export default async function Layout({ children, params }: LayoutProps<"/settings/automations/[id]">) {
  const { id } = await params;
  if (id !== "new") {
    const { ctx, db } = await pageContext();
    await load(() => getAutomationDetail(db, ctx, decodeURIComponent(id)));
  }
  return children;
}
