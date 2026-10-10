import { forbidden } from "next/navigation";
import { loadJobRef } from "@/server/auth/job-ref";
import { allowed, load, pageContext } from "@/server/page";
import { getJobDetail } from "@/server/queries/jobDetail";

/**
 * Edit gate above the loading boundary: a viewer who may change no field
 * group gets a real 403 status. Mirrors the check in ./page.tsx.
 */
export default async function EditJobLayout({ children, params }: LayoutProps<"/jobs/[id]/edit">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  const { job, actions } = await load(() => getJobDetail(db, ctx, decodeURIComponent(id)));
  // Full ref (draft window, project sharing, past editors) — docs/ROLES.md §2.1.
  const { ref } = await loadJobRef(db, ctx, job.id);
  const canEdit =
    actions.canEditFields ||
    actions.canEditDeadlines ||
    actions.canSetPriority ||
    allowed(ctx, "job.change_client", ref) ||
    allowed(ctx, "job.edit_completion_percent", ref);
  if (!canEdit) forbidden();
  return children;
}
