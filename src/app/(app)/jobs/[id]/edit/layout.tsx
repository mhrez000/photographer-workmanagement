import { forbidden } from "next/navigation";
import type { JobPermissionRef } from "@/lib/types";
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
  const ref: JobPermissionRef = {
    id: job.id,
    organisationId: ctx.organisationId,
    photographerId: job.photographer?.id ?? null,
    editorId: job.editor?.id ?? null,
    createdByUserId: job.createdBy.id,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
  };
  const canEdit =
    actions.canEditFields || actions.canEditDeadlines || actions.canSetPriority || allowed(ctx, "job.edit_completion_percent", ref);
  if (!canEdit) forbidden();
  return children;
}
