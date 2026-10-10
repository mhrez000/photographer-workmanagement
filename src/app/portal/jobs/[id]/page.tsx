import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PortalJobView } from "@/components/portal/portal-job-view";
import { getViewer } from "@/server/auth/session";
import { load, portalPageContext } from "@/server/page";
import { getPortalJob, ownFeedbackIds } from "@/server/queries/portal";

export async function generateMetadata({ params }: PageProps<"/portal/jobs/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const { ctx, db } = await portalPageContext();
    const job = await getPortalJob(db, ctx, decodeURIComponent(id));
    return { title: job.name };
  } catch {
    return { title: "Shared work" };
  }
}

/** /portal/jobs/[id] — milestones, agreed dates, "View your photos", delivery notes, feedback (docs/ROLES.md §7.7). */
export default async function PortalJobPage({ params }: PageProps<"/portal/jobs/[id]">) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const { ctx, db } = await portalPageContext();
  const viewer = await getViewer();
  const job = await load(() => getPortalJob(db, ctx, id));
  const ownIds = await load(() => ownFeedbackIds(db, ctx, id));

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-ink-muted">
        <Link href="/portal" className="inline-flex items-center gap-1 rounded-md hover:text-ink focus-ring">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Your work
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/portal/projects/${job.project.id}`} className="truncate rounded-md hover:text-ink focus-ring">
          {job.project.name}
        </Link>
      </nav>
      <PortalJobView
        job={job}
        timeZone={ctx.settings.timezone}
        studioName={viewer?.organisationName ?? "your studio"}
        ownIds={ownIds}
        feedbackEnabled={ctx.clientFeedbackEnabled}
      />
    </div>
  );
}
