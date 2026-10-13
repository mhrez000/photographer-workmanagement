import type { Metadata } from "next";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { CreateJobForm } from "@/components/job-form";
import { todayCivil } from "@/lib/dates";
import type { EditorPickerOption, UserOption } from "@/lib/types";
import { isAdmin } from "@/server/auth/permissions";
import { getViewer } from "@/server/auth/session";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { editorPickerOptions } from "@/server/queries/editors";
import { getJobFormDefaults, getLastUsedJobTypeId } from "@/server/queries/job-form";
import { getClientOptions, getProjectOptions, getUserOptions } from "@/server/queries/options";
import { loadUsualDaysToEdit } from "@/server/queries/simpleColumns";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "New job" };

/**
 * New job (docs/SIMPLIFICATION-PLAN.md §5): one screen, 8 fields, a collapsed "More options".
 * `?clientId=` pre-selects the client (from a client page); `?editorId=` pre-selects the editor (an
 * editor page's "Give them a job", ignored unless it is one of the picker's editors); `?projectId=` (project pages, Advanced
 * tools) pre-fills the client and the address. There is no project field: `createJob` reuses or creates
 * the project from client + address (`autoProject`).
 *
 * Per persona (docs/ROLES.md §4): owners pick any editor and, under More options, the photographer
 * when the studio has more than one; extra photographers are the photographer on their own jobs and see
 * the editor picker only with "Assign editors"; editors say who shot it (pre-filled with the owner) and
 * choose "Assign to me" or "Leave unassigned".
 */
export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "job.create");
  const sp = await searchParams;
  const viewer = await getViewer();
  const admin = isAdmin(ctx);
  const editor = ctx.role === "editor";
  const tz = ctx.settings.timezone;

  const [jobTypes, usualDaysMap, clients, lastUsed] = await Promise.all([
    load(() => listJobTypes(db, ctx)),
    load(() => loadUsualDaysToEdit(db, ctx)),
    load(() => getClientOptions(db, ctx)),
    load(() => getLastUsedJobTypeId(db, ctx)),
  ]);

  let initialClientId = param(sp, "clientId") ?? null;
  let initialAddress: string | undefined;
  const projectId = param(sp, "projectId");
  if (projectId) {
    const match = (await load(() => getProjectOptions(db, ctx, {}))).find((p) => p.id === projectId);
    if (match) {
      initialClientId = match.clientId;
      initialAddress = match.name;
    }
  }
  if (initialClientId && !clients.some((c) => c.id === initialClientId)) initialClientId = null;

  const photographerMode = admin ? "pick" : editor ? "required" : "self";
  const editorMode = editor ? "self" : admin || ctx.canAssignEditors ? "pick" : "none";
  const photographers: UserOption[] = photographerMode === "self" ? [] : await load(() => getUserOptions(db, ctx, { role: "photographer" }));
  const editors: EditorPickerOption[] = editorMode === "pick" ? await load(() => editorPickerOptions(db, ctx)) : [];
  const defaults = editor ? await load(() => getJobFormDefaults(db, ctx)) : null;
  const defaultPhotographerId = admin ? ctx.userId : (defaults?.defaultPhotographerId ?? null);

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow={[{ label: "Jobs", href: editor ? "/my-jobs" : "/jobs" }, { label: "New job" }]}
        title="New job"
        description={editor ? "Set up the shoot you're editing. The studio sees it straight away." : "Shoot → give it to an editor. Everything else can wait."}
      />
      <CreateJobForm
        viewer={{ id: ctx.userId ?? "", name: viewer?.name ?? "You", role: ctx.role, avatarColour: viewer?.avatarColour ?? "", isAdmin: ctx.isAdmin }}
        timeZone={tz}
        today={todayCivil(tz, new Date(ctx.now()))}
        jobTypes={jobTypes}
        usualDays={Object.fromEntries(usualDaysMap)}
        defaultJobTypeId={lastUsed}
        clients={clients}
        initialClientId={initialClientId}
        initialAddress={initialAddress}
        initialEditorId={param(sp, "editorId") ?? null}
        canCreateClient={!editor && allowed(ctx, "client.create")}
        photographerMode={photographerMode}
        photographers={photographers}
        defaultPhotographerId={defaultPhotographerId}
        editorMode={editorMode}
        editors={editors}
        cancelHref={editor ? "/my-jobs" : "/jobs"}
      />
    </PageContainer>
  );
}
