import { redirect } from "next/navigation";
import { EDITOR_HOME_PATH, pageContext } from "@/server/page";

/**
 * Jobs is the photographers' one list (docs/SIMPLIFICATION-PLAN.md §1, §3). An editor's one list
 * is My jobs, so they are sent there; the redirect sits above the loading boundary (real 307).
 */
export default async function JobsListLayout({ children }: { children: React.ReactNode }) {
  const { ctx } = await pageContext();
  if (ctx.role === "editor") redirect(EDITOR_HOME_PATH);
  return children;
}
