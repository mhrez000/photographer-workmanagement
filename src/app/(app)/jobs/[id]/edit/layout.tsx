import { forbidden } from "next/navigation";
import { loadJobRef } from "@/server/auth/job-ref";
import { allowed, load, pageContext } from "@/server/page";

/**
 * Edit gate above the loading boundary: a viewer who may change none of the
 * simple fields (name / instructions / type / shoot date, due dates, Rush) gets
 * a real 403 status. Mirrors the check in ./page.tsx.
 */
export default async function EditJobLayout({ children, params }: LayoutProps<"/jobs/[id]/edit">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  const { ref } = await load(() => loadJobRef(db, ctx, decodeURIComponent(id)));
  const canEdit = allowed(ctx, "job.edit_fields", ref) || allowed(ctx, "job.set_due_date", ref) || allowed(ctx, "job.set_priority", ref);
  if (!canEdit) forbidden();
  return children;
}
