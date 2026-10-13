import { redirect } from "next/navigation";
import { pageContext } from "@/server/page";

/** The old Calendar address (docs/SIMPLIFICATION-PLAN.md §3): editors get their Calendar page, photographers the Jobs calendar. next.config.ts 307s first; this is the fallback. */
export default async function WorkspaceCalendarRedirect() {
  const { ctx } = await pageContext();
  redirect(ctx.role === "editor" ? "/calendar" : "/jobs?view=calendar");
}
