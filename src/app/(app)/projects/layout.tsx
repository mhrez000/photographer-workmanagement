import { pageContext, redirectUnlessAdvanced } from "@/server/page";

/**
 * Projects are hidden behind Settings → Studio → Advanced tools (docs/SIMPLIFICATION-PLAN.md §8). While the
 * switch is off, every /projects address goes to Jobs: a project is created silently from the address on
 * the New job form, and the client page groups jobs by address. Sits above the loading boundaries so the
 * redirect is a real 307.
 */
export default async function ProjectsLayout({ children }: LayoutProps<"/projects">) {
  const { ctx } = await pageContext();
  redirectUnlessAdvanced(ctx, "projects", "/jobs");
  return children;
}
