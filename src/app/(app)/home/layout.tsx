import { redirect } from "next/navigation";
import { EDITOR_HOME_PATH, pageContext } from "@/server/page";

/**
 * Home is the photographers' landing page (docs/SIMPLIFICATION-PLAN.md §3, §6). Editors live on
 * My jobs: the redirect sits in the layout, above the loading boundary, so it is a real 307.
 */
export default async function HomeLayout({ children }: LayoutProps<"/home">) {
  const { ctx } = await pageContext();
  if (ctx.role === "editor") redirect(EDITOR_HOME_PATH);
  return children;
}
