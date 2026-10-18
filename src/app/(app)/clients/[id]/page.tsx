import type { Metadata } from "next";
import { Briefcase, Mail, Phone, Plus } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { ArchiveControl } from "@/components/production/archive-control";
import { EditClientDialog } from "@/components/production/client-form";
import { ClientJobsByAddress } from "@/components/production/client-jobs";
import { ClientOnlineAccess, type ClientUserInvite } from "@/components/production/client-online-access";
import { PageContainer } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/dates";
import { getViewer } from "@/server/auth/session";
import { allowed, guard, load, pageContext } from "@/server/page";
import { getClientDetail, listClientJobsSimple } from "@/server/queries/clients";
import { getClientPortalAccess } from "@/server/queries/portal";
import { listUsers } from "@/server/queries/users";
import { pendingInviteFor } from "@/server/services/invites";

export const metadata: Metadata = { title: "Client" };

/**
 * One client (docs/SIMPLIFICATION-PLAN.md §3): who they are, their jobs grouped by address with the stage
 * pill, and — for the owner — "Client can see their work online", feedback and who can sign in.
 */
export default async function ClientDetailPage({ params }: PageProps<"/clients/[id]">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "client.view");
  const { id } = await params;
  const tz = ctx.settings.timezone;
  const detail = await load(() => getClientDetail(db, ctx, id));
  const jobs = await load(() => listClientJobsSimple(db, ctx, id));
  const { client, counts } = detail;
  const resource = { organisationId: ctx.organisationId, createdByUserId: client.createdByUserId ?? undefined };
  const canEdit = allowed(ctx, "client.edit", resource);
  const canArchive = allowed(ctx, "client.archive", resource);
  const canCreateJob = allowed(ctx, "job.create") && !client.archivedAt;
  const canManagePortal = allowed(ctx, "client.manage_portal", { organisationId: ctx.organisationId });
  const access = canManagePortal ? await load(() => getClientPortalAccess(db, ctx, client.id)) : null;
  const studioName = access ? ((await getViewer())?.organisationName ?? "Your studio") : "";
  // Front door: which of this client's portal users have not opened their invite link yet (and whether a link still works).
  const invites: Record<string, ClientUserInvite> = {};
  if (access && access.users.some((u) => u.isActive)) {
    const profiles = await load(() => listUsers(db, ctx, { role: "client", active: "1" }));
    for (const u of profiles) {
      if (!("email" in u) || u.clientId !== client.id || u.acceptedAt !== null || u.anonymisedAt) continue;
      invites[u.id] = { live: await load(() => pendingInviteFor(db, u.id, ctx.now())) };
    }
  }
  const active = jobs.filter((j) => j.stage.active).length;
  const late = jobs.filter((j) => j.due.late).length;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={[{ label: "Clients", href: "/clients" }, { label: client.name }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={client.name} colour={client.colour} size="lg" shape="rounded" />
            {client.name}
          </span>
        }
        meta={client.archivedAt ? <Badge variant="outline">Archived {formatDate(client.archivedAt, tz)}</Badge> : null}
        description={
          client.contactName || client.email || client.phone ? (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {client.contactName ? <span className="text-ink-secondary">{client.contactName}</span> : null}
              {client.email ? (
                <a href={`mailto:${client.email}`} className="inline-flex items-center gap-1.5 rounded-xs hover:text-ink focus-ring">
                  <Mail aria-hidden="true" className="size-3.5" />
                  {client.email}
                </a>
              ) : null}
              {client.phone ? (
                <a href={`tel:${client.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5 rounded-xs hover:text-ink focus-ring numeric">
                  <Phone aria-hidden="true" className="size-3.5" />
                  {client.phone}
                </a>
              ) : null}
            </span>
          ) : (
            "No contact details yet."
          )
        }
        actions={
          <>
            {canArchive ? (
              <ArchiveControl entity="client" id={client.id} name={client.name} version={client.version} archived={Boolean(client.archivedAt)} openJobs={counts.open} timeZone={tz} />
            ) : null}
            {canEdit ? <EditClientDialog client={client} notes={detail.notes} canSeeNotes={ctx.role !== "editor"} timeZone={tz} /> : null}
            {canCreateJob ? (
              <Button href={`/jobs/new?clientId=${client.id}`} size="sm" leadingIcon={<Plus aria-hidden="true" />}>
                New job
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard
          title="Jobs"
          description={
            jobs.length > 0 ? (
              <span className="numeric">
                {jobs.length} {jobs.length === 1 ? "job" : "jobs"} · {active} active
                {late > 0 ? <span className="text-danger-fg"> · {late} late</span> : null}
              </span>
            ) : undefined
          }
          flush
        >
          {jobs.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              size="sm"
              title="No jobs for this client yet"
              description="Shoot something for them, then press New job."
              action={
                canCreateJob ? (
                  <Button href={`/jobs/new?clientId=${client.id}`} size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />}>
                    New job
                  </Button>
                ) : null
              }
            />
          ) : (
            <ClientJobsByAddress jobs={jobs} timeZone={tz} />
          )}
        </SectionCard>

        <div className="flex min-w-0 flex-col gap-6">
          {access ? <ClientOnlineAccess access={access} studioName={studioName} timeZone={tz} invites={invites} /> : null}

          {ctx.role !== "editor" && detail.notes ? (
            <SectionCard title="Private notes" description="Only you and your photographers see this.">
              <p className="whitespace-pre-line text-sm text-ink-secondary">{detail.notes}</p>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
