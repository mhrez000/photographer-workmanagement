import type { Metadata } from "next";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { CreateJobForm } from "@/components/job-form";
import { EDITOR_LINK_KINDS, type LinkKind, type NoteKind } from "@/lib/constants";
import { todayCivil } from "@/lib/dates";
import { isAdmin } from "@/server/auth/permissions";
import { getViewer } from "@/server/auth/session";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { getJobFormDefaults } from "@/server/queries/job-form";
import { getClientOptions, getProjectOptions } from "@/server/queries/options";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "New job" };

/**
 * Create a job (ARCHITECTURE §10 `/jobs/new`; guard `job.create`).
 * `?clientId=` / `?projectId=` preselect the cascade (e.g. from a project page).
 *
 * Per persona (docs/ROLES.md §4):
 * - Owner / Photographer (admin): any active photographer (default: themselves), any editor, every note kind.
 * - Team member ("Create jobs"): they are the photographer; editor picker only with "Assign editors".
 * - Editor ("Create jobs"): photographer required (studio default pre-filled), "Assign to me" or
 *   "Leave unassigned", existing client, existing or inline new project, shoot date = today.
 */
export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "job.create");
  const sp = await searchParams;
  const viewer = await getViewer();

  const jobTypes = await load(() => listJobTypes(db, ctx));
  const clients = await load(() => getClientOptions(db, ctx));

  let initialClientId = param(sp, "clientId") ?? null;
  let initialProjectId = param(sp, "projectId") ?? null;
  if (initialProjectId) {
    const match = (await load(() => getProjectOptions(db, ctx, {}))).find((p) => p.id === initialProjectId);
    if (match) initialClientId = match.clientId;
    else initialProjectId = null;
  }
  if (initialClientId && !clients.some((c) => c.id === initialClientId)) {
    initialClientId = null;
    initialProjectId = null;
  }
  const projects = initialClientId ? await load(() => getProjectOptions(db, ctx, { clientId: initialClientId })) : [];

  const admin = isAdmin(ctx);
  const editor = ctx.role === "editor";
  const defaults = editor ? await load(() => getJobFormDefaults(db, ctx)) : null;
  const noteKinds: NoteKind[] = editor ? ["editor"] : admin ? ["photographer", "client", "internal"] : ["photographer", "client"];
  const editorLinkKinds: readonly LinkKind[] = ["raw_files", ...EDITOR_LINK_KINDS.filter((k) => k !== "raw_files")];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={[{ label: "Jobs", href: "/workspace/all" }, { label: "New job" }]}
        title="New job"
        description={
          editor
            ? "Set up the job for the shoot you're editing: who shot it, the client and project, and the raw files."
            : "Set up the work once — client, people, deadlines and links — and everyone sees the same picture from here on."
        }
      />
      <CreateJobForm
        viewer={{
          id: ctx.userId ?? "",
          name: viewer?.name ?? "You",
          role: ctx.role,
          avatarColour: viewer?.avatarColour ?? "",
          isAdmin: ctx.isAdmin,
          title: viewer?.title ?? null,
        }}
        timeZone={ctx.settings.timezone}
        jobTypes={jobTypes}
        clients={clients}
        projects={projects}
        initialClientId={initialClientId}
        initialProjectId={initialProjectId}
        photographerMode={admin ? "pick" : editor ? "required" : "self"}
        defaultPhotographerId={admin ? ctx.userId : (defaults?.defaultPhotographerId ?? null)}
        editorMode={editor ? "self" : admin || ctx.canAssignEditors ? "pick" : "none"}
        noteKinds={noteKinds}
        linkKinds={editor ? editorLinkKinds : undefined}
        canCreateClient={!editor && allowed(ctx, "client.create")}
        canCreateProject={!editor && allowed(ctx, "project.create")}
        inlineNewProject={editor}
        initialShootDate={editor ? todayCivil(ctx.settings.timezone, new Date(ctx.now())) : undefined}
        cancelHref={editor ? "/workspace/my" : "/workspace/all"}
      />
    </PageContainer>
  );
}
