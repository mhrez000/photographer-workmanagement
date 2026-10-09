import { forbidden } from "next/navigation";
import { pageContext } from "@/server/page";
import { canViewTeamWork } from "./access";

/**
 * Access gate for Team Work. It lives in the layout (outside this segment's
 * loading boundary) so a denied viewer gets a real 403 response instead of a
 * streamed 200 that later swaps in the forbidden UI.
 */
export default async function TeamWorkLayout({ children }: LayoutProps<"/workspace/team">) {
  const { ctx } = await pageContext();
  if (!canViewTeamWork(ctx)) forbidden();
  return children;
}
