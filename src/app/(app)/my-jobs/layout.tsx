import { redirect } from "next/navigation";
import { homePathFor, pageContext } from "@/server/page";

/**
 * My jobs is the editor's only home (docs/SIMPLIFICATION-PLAN.md §6). Photographers live on Home, so
 * anyone else who lands here is sent to their own landing page (above the loading boundary, so it is a
 * real redirect). `getMyJobs` re-checks with a 403.
 */
export default async function MyJobsLayout({ children }: LayoutProps<"/my-jobs">) {
  const { ctx } = await pageContext();
  if (ctx.role !== "editor") redirect(homePathFor(ctx));
  return children;
}
