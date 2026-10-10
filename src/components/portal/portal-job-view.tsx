import type { ComponentType, ReactNode } from "react";
import { CalendarDays, Camera, MapPin, PackageCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { portalDate } from "@/lib/portal";
import type { PortalJobDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MilestoneStepper } from "./milestone-stepper";
import { MilestoneBadge } from "./portal-job-card";
import { PortalDeliveryLinks, PortalDeliveryNotes } from "./portal-delivery";
import { PortalFeedback } from "./portal-feedback";

export interface PortalJobViewProps {
  job: PortalJobDetail;
  timeZone: string;
  studioName: string;
  /** Viewer's own feedback ids (edit / delete). */
  ownIds?: string[];
  /** Feedback switched on for the client (explains a missing composer). */
  feedbackEnabled: boolean;
  /** Staff "What the client sees" preview: read-only, no composer. */
  preview?: boolean;
}

/** "14 Ocean Street · 14 Ocean Street, Bondi" reads twice: show the address alone when it starts with the project name. */
function projectLine(project: PortalJobDetail["project"]): string {
  if (!project.address) return project.name;
  return project.address.toLowerCase().startsWith(project.name.toLowerCase()) ? project.address : `${project.name} · ${project.address}`;
}

function Section({ id, title, description, children, className }: { id: string; title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3", className)}>
      <div>
        <h2 id={id} className="text-md font-semibold text-ink">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; label: string; value: string | null }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon aria-hidden={true} className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
      <div className="min-w-0">
        <dt className="text-xs text-ink-muted">{label}</dt>
        <dd className="numeric truncate text-sm font-medium text-ink">{value ?? "Not set yet"}</dd>
      </div>
    </div>
  );
}

/**
 * The client's view of one shared job (docs/ROLES.md §7.7): milestones with the
 * agreed dates, finished-work links, delivery notes and the feedback thread.
 * Used by /portal/jobs/[id] and the staff "What the client sees" preview, so
 * both render from the same `toPortalJob` projection.
 */
export function PortalJobView({ job, timeZone, studioName, ownIds = [], feedbackEnabled, preview = false }: PortalJobViewProps) {
  const delivered = job.milestone === "delivered";
  const disabledReason = preview
    ? "Preview: the client writes here when feedback is on."
    : job.cancelled
      ? "This job was cancelled, so feedback is closed."
      : !feedbackEnabled
        ? `Feedback in the portal is turned off. Contact ${studioName} directly with any questions.`
        : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-xs sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">
              {job.jobTypeName} · <span className="numeric">{job.jobNumber}</span>
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">{job.name}</h1>
            <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-ink-muted">
              <MapPin aria-hidden="true" className="size-3.5" />
              {projectLine(job.project)}
            </p>
          </div>
          {/* The stepper shows the milestone; only a cancelled job (no stepper) gets the badge. */}
          {job.cancelled ? <MilestoneBadge job={job} /> : null}
        </div>

        {job.cancelled ? (
          <p className="rounded-lg bg-surface-sunken px-4 py-3 text-sm text-ink-secondary">{job.milestoneDetail ?? "Cancelled by the studio"}</p>
        ) : (
          <>
            <MilestoneStepper job={job} timeZone={timeZone} />
            {job.updating ? (
              <p className="flex items-start gap-2 rounded-lg bg-attention-soft/60 px-4 py-3 text-sm text-attention-fg">
                <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  <strong className="font-semibold">Updating your delivery.</strong> Your delivered files stay available while {studioName} works on the update.
                </span>
              </p>
            ) : job.milestoneDetail && !delivered ? (
              <p className="text-sm text-ink-secondary">{job.milestoneDetail}</p>
            ) : null}
          </>
        )}

        <dl className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-3">
          <Fact icon={Camera} label="Shoot date" value={portalDate(job.shootDate, timeZone)} />
          <Fact icon={CalendarDays} label="Agreed delivery date" value={portalDate(job.deliveryDueDate, timeZone)} />
          <Fact icon={PackageCheck} label="Delivered" value={delivered ? portalDate(job.deliveredAt, timeZone) : job.cancelled ? "—" : "Not yet"} />
        </dl>
        {job.photographer ? <p className="-mt-1 text-sm text-ink-muted">Photographer: {job.photographer.name}</p> : null}
      </div>

      {!job.cancelled ? (
        <Section
          id="portal-links"
          title={delivered ? "View your photos" : "Shared files"}
          description={delivered ? "Open your finished work. Links open in a new tab." : "Files the studio has shared with you so far."}
        >
          <PortalDeliveryLinks
            links={job.links}
            emptyText={delivered ? `${studioName} hasn't added a link yet. They'll let you know.` : "Your finished photos will appear here once they're delivered."}
          />
        </Section>
      ) : null}

      {job.deliveryNotes.length > 0 ? (
        <Section id="portal-notes" title="Delivery notes" description={`From ${studioName}.`}>
          <PortalDeliveryNotes notes={job.deliveryNotes} timeZone={timeZone} />
        </Section>
      ) : null}

      <Section
        id="portal-feedback"
        title="Feedback"
        description={preview ? undefined : job.canGiveFeedback ? `Messages here go to ${studioName}.` : undefined}
      >
        {preview ? (
          <Badge variant="outline" className="self-start">
            Read-only preview
          </Badge>
        ) : null}
        <PortalFeedback
          jobId={job.id}
          threads={job.feedback}
          canGiveFeedback={!preview && job.canGiveFeedback}
          disabledReason={disabledReason}
          ownIds={preview ? [] : ownIds}
          studioName={studioName}
          timeZone={timeZone}
        />
      </Section>
    </div>
  );
}
