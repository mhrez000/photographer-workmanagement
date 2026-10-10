import { guard, pageContext } from "@/server/page";

/**
 * Directory gate above the loading boundary (`team.view_members`: admins and team
 * members; editors never — docs/ROLES.md §3.3), so a refused viewer gets a real 403
 * status instead of the forbidden page streamed under a 200.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const { ctx } = await pageContext();
  guard(ctx, "team.view_members");
  return children;
}
