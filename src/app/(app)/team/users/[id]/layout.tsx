import { guard, load, pageContext } from "@/server/page";
import { getUserDetail } from "@/server/queries/users";

/** Existence + visibility gate above the loading boundary, so a missing or hidden person gets a real 404/403 status. */
export default async function Layout({ children, params }: LayoutProps<"/team/users/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "user.view");
  await load(() => getUserDetail(db, ctx, decodeURIComponent(id)));
  return children;
}
