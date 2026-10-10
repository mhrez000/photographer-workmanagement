import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, MapPin } from "lucide-react";
import { PortalJobCard } from "@/components/portal/portal-job-card";
import { load, portalPageContext } from "@/server/page";
import { getPortalProject } from "@/server/queries/portal";

export async function generateMetadata({ params }: PageProps<"/portal/projects/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const { ctx, db } = await portalPageContext();
    const group = await getPortalProject(db, ctx, decodeURIComponent(id));
    return { title: group.project.name };
  } catch {
    return { title: "Project" };
  }
}

/** /portal/projects/[id] — every shared job at one property / project. */
export default async function PortalProjectPage({ params }: PageProps<"/portal/projects/[id]">) {
  const { id } = await params;
  const { ctx, db } = await portalPageContext();
  const { project, jobs } = await load(() => getPortalProject(db, ctx, decodeURIComponent(id)));
  const delivered = jobs.filter((j) => j.milestone === "delivered" && !j.updating).length;

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb">
        <Link href="/portal" className="inline-flex items-center gap-1 rounded-md text-sm text-ink-muted hover:text-ink focus-ring">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Your work
        </Link>
      </nav>
      <header>
        <p className="eyebrow">Project</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{project.name}</h1>
        {project.address ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm text-ink-muted">
            <MapPin aria-hidden="true" className="size-3.5" />
            {project.address}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-ink-secondary">
          {jobs.length} shared {jobs.length === 1 ? "job" : "jobs"} · {delivered} delivered
        </p>
      </header>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {jobs.map((job) => (
          <li key={job.id} className="min-w-0">
            <PortalJobCard job={job} timeZone={ctx.settings.timezone} hideProject />
          </li>
        ))}
      </ul>
    </div>
  );
}
