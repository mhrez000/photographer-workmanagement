import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Images, MapPin } from "lucide-react";
import { PortalJobCard } from "@/components/portal/portal-job-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PORTAL_SORTS, type PortalSort } from "@/lib/portal";
import { cn } from "@/lib/utils";
import { getViewer } from "@/server/auth/session";
import { load, param, portalPageContext } from "@/server/page";
import { listPortalProjectGroups } from "@/server/queries/portal";

export const metadata: Metadata = { title: "Your work" };

const SORT_LABELS: Record<PortalSort, string> = { progress: "In progress first", delivered: "Delivered first" };

/** /portal — "Your work": shared jobs grouped by project (docs/ROLES.md §7.7). */
export default async function PortalHome({ searchParams }: PageProps<"/portal">) {
  const sp = await searchParams;
  const { ctx, db } = await portalPageContext();
  const viewer = await getViewer();
  const requested = param(sp, "sort");
  const sort: PortalSort = (PORTAL_SORTS as readonly string[]).includes(requested ?? "") ? (requested as PortalSort) : "progress";
  const groups = await load(() => listPortalProjectGroups(db, ctx, { sort }));
  const tz = ctx.settings.timezone;
  const all = groups.flatMap((g) => g.jobs);
  const inProgress = all.filter((j) => !j.cancelled && (j.milestone !== "delivered" || j.updating)).length;
  const delivered = all.filter((j) => j.milestone === "delivered" && !j.updating).length;
  const firstName = viewer?.name.split(" ")[0] ?? "";

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="eyebrow">{firstName ? `Welcome, ${firstName}` : viewer?.clientName}</p>
          <h1 id="portal-heading" className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Your work
          </h1>
          <p className="mt-1.5 max-w-prose text-sm text-ink-secondary">
            {all.length === 0
              ? `Work ${viewer?.organisationName ?? "your studio"} shares with ${viewer?.clientName ?? "you"} appears here.`
              : `${inProgress} in progress · ${delivered} delivered. Shared with you by ${viewer?.organisationName ?? "your studio"}.`}
          </p>
        </div>
        {all.length > 1 ? (
          <nav aria-label="Sort" className="inline-flex self-start rounded-lg border border-border bg-surface p-0.5 shadow-xs sm:self-auto">
            {PORTAL_SORTS.map((s) => (
              <Link
                key={s}
                href={s === "progress" ? "/portal" : `/portal?sort=${s}`}
                aria-current={sort === s ? "true" : undefined}
                scroll={false}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-ring",
                  sort === s ? "bg-surface-muted text-ink" : "text-ink-muted hover:text-ink",
                )}
              >
                {SORT_LABELS[s]}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      {groups.length === 0 ? (
        <EmptyState
          icon={Images}
          bordered
          size="lg"
          title="No shared work yet"
          description="Nothing has been shared with you yet. Your studio will let you know."
        />
      ) : (
        <div className="flex flex-col gap-10">
          {groups.map((g) => (
            <section key={g.project.id} aria-labelledby={`project-${g.project.id}`} className="flex flex-col gap-3">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={`project-${g.project.id}`} className="truncate text-lg font-semibold text-ink">
                    {g.project.name}
                  </h2>
                  {g.project.address && g.project.address.trim().toLowerCase() !== g.project.name.trim().toLowerCase() ? (
                    <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-ink-muted">
                      <MapPin aria-hidden="true" className="size-3.5" />
                      {g.project.address}
                    </p>
                  ) : null}
                </div>
                {g.jobs.length > 1 ? (
                  <Link
                    href={`/portal/projects/${g.project.id}`}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-md text-sm font-medium text-accent-ink hover:underline focus-ring"
                  >
                    {g.jobs.length} jobs
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Link>
                ) : null}
              </div>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {g.jobs.map((job) => (
                  <li key={job.id} className="min-w-0">
                    <PortalJobCard job={job} timeZone={tz} hideProject />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
