import "server-only";
import type { DbLike } from "@/db/index";
import { PortalJobView } from "@/components/portal/portal-job-view";
import type { AuthContext } from "@/lib/types";
import { can } from "@/server/auth/permissions";
import { getViewer } from "@/server/auth/session";
import { getClientPortalAccess, getClientPreview, getJobClientAccess, getProjectClientSharing } from "@/server/queries/portal";
import { ClientAccessCard } from "./client-access-card";
import { ClientPortalCard } from "./client-portal-card";
import { ProjectShareCard } from "./project-share-card";

/**
 * Server sections that load their own data, so a page mounts the sharing
 * controls with one line (`<JobClientAccessSection ctx={ctx} db={db} jobId={job.id} />`).
 * Each renders nothing for a viewer who must not see it.
 */

/** Job detail "Client access" card + "What the client sees" preview. Hidden from editors without assigned/teamView access. */
export async function JobClientAccessSection({ ctx, db, jobId }: { ctx: AuthContext; db: DbLike; jobId: string }) {
  if (ctx.role === "client") return null;
  const access = await getJobClientAccess(db, ctx, jobId);
  if (!access) return null;
  const preview = await getClientPreview(db, ctx, jobId);
  const studioName = (await getViewer())?.organisationName ?? "Your studio";
  return (
    <ClientAccessCard
      access={access}
      timeZone={ctx.settings.timezone}
      preview={
        <PortalJobView job={preview.job} timeZone={ctx.settings.timezone} studioName={studioName} feedbackEnabled={access.client.feedbackEnabled} preview />
      }
    />
  );
}

/** Project page share switch (photographers; admins can change it). */
export async function ProjectClientSharingSection({ ctx, db, projectId }: { ctx: AuthContext; db: DbLike; projectId: string }) {
  if (ctx.role !== "photographer") return null;
  const sharing = await getProjectClientSharing(db, ctx, projectId);
  return <ProjectShareCard sharing={sharing} canManagePortal={can(ctx, "client.manage_portal", { organisationId: ctx.organisationId })} />;
}

/** Client page "Client portal" card (admins: `client.manage_portal`). */
export async function ClientPortalSection({ ctx, db, clientId }: { ctx: AuthContext; db: DbLike; clientId: string }) {
  if (!can(ctx, "client.manage_portal", { organisationId: ctx.organisationId })) return null;
  const access = await getClientPortalAccess(db, ctx, clientId);
  const studioName = (await getViewer())?.organisationName ?? "Your studio";
  return <ClientPortalCard access={access} studioName={studioName} timeZone={ctx.settings.timezone} />;
}
