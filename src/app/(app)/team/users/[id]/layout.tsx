import { forbidden } from "next/navigation";
import { guard, load, pageContext } from "@/server/page";
import { getUserDetail } from "@/server/queries/users";
import { canOpenPersonPage } from "@/server/queries/workloads";

/**
 * Existence + visibility gate above the loading boundary, so a missing or hidden person gets a real 404/403 status.
 * Person pages (docs/ROLES.md §3.4): admin; self; a team member with ⚑workloads / ⚑analytics on an editor's page,
 * ⚑analytics on a photographer's. `user.view` alone (every staff persona) is not enough.
 */
export default async function Layout({ children, params }: LayoutProps<"/team/users/[id]">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  guard(ctx, "user.view");
  const { ref } = await load(() => getUserDetail(db, ctx, decodeURIComponent(id)));
  if (!canOpenPersonPage(ctx, ref, "workload") && !canOpenPersonPage(ctx, ref, "performance")) forbidden();
  return children;
}
