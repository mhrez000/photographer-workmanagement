import { redirect } from "next/navigation";
import { EDITOR_HOME_PATH, pageContext } from "@/server/page";

/**
 * Clients is a photographer / owner page (docs/SIMPLIFICATION-PLAN.md §3: editors no longer see Projects,
 * Clients or other editors' work). Editors who open an old link land on My jobs. Sits above every
 * loading boundary so the redirect is a real 307.
 */
export default async function ClientsLayout({ children }: LayoutProps<"/clients">) {
  const { ctx } = await pageContext();
  if (ctx.role === "editor") redirect(EDITOR_HOME_PATH);
  return children;
}
