import { guard, load, pageContext } from "@/server/page";
import { getUserDetail } from "@/server/queries/users";

/** Existence + visibility gate above the loading boundary, so a missing or hidden user gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/settings/users/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  await load(() => getUserDetail(db, ctx, decodeURIComponent(id)));
  return children;
}
