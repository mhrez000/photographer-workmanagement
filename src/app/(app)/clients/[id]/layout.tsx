import { guard, load, pageContext } from "@/server/page";
import { getClientDetail } from "@/server/queries/clients";

/** Existence + visibility gate above the loading boundary, so a missing or hidden client gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/clients/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "client.view");
  await load(() => getClientDetail(db, ctx, decodeURIComponent(id)));
  return children;
}
