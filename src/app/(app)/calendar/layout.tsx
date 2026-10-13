import { redirect } from "next/navigation";
import { pageContext } from "@/server/page";

/**
 * /calendar is the editor's page (docs/SIMPLIFICATION-PLAN.md §3, §11: "Calendar is a view inside
 * Jobs for you, and a page for editors"). Photographers get the Jobs calendar; the redirect sits
 * above the loading boundary so it is a real 307.
 */
export default async function CalendarLayout({ children }: LayoutProps<"/calendar">) {
  const { ctx } = await pageContext();
  if (ctx.role !== "editor") redirect("/jobs?view=calendar");
  return children;
}
