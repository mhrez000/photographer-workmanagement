import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageContainer } from "@/components/shell";
import {
  ChangesAskedSection,
  FilesSection,
  FromClient,
  InstructionsSection,
  JobHeaderSimple,
  MessagesThread,
  NextStepCard,
  PrivateNotes,
  SideColumn,
  WhoDidWhat,
} from "@/components/job-simple";
import { SIMPLE_LINK_SLOTS, type LinkKind, type NoteKind } from "@/lib/constants";
import type { CommentNode } from "@/lib/types";
import { loadJobRef } from "@/server/auth/job-ref";
import { NotFoundError } from "@/server/errors";
import { EDITOR_HOME_PATH, allowed, load, pageContext, param } from "@/server/page";
import { getJobPageSimple } from "@/server/queries/jobPageSimple";
import { getJobRowByNumber, getJobRowsByIds } from "@/server/queries/jobs";

/** "PJ-0042", "pj-42" — a human job number rather than an id. */
const JOB_NUMBER = /^[A-Za-z]{1,8}-\d{1,8}$/;

export async function generateMetadata({ params }: PageProps<"/jobs/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const { ctx, db } = await pageContext();
    const row = JOB_NUMBER.test(id) ? await getJobRowByNumber(db, ctx, id) : (await getJobRowsByIds(db, ctx, [id]))[0];
    return { title: row ? `${row.jobNumber} · ${row.name}` : "Job" };
  } catch {
    return { title: "Job" };
  }
}

function flatten(nodes: readonly CommentNode[]): CommentNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.replies)]);
}

/**
 * The job page (docs/SIMPLIFICATION-PLAN.md §5): one scrolling page, no tabs.
 * Header → Next step → Files → Instructions → Changes asked → Messages →
 * Private notes → From the client → Who did what, with the details column
 * beside it (below it on phones, where the next-step card is pinned at the
 * bottom). The complete audit log stays one click away at /jobs/[id]/history.
 */
export default async function JobDetailPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const { ctx, db } = await pageContext();
  const id = decodeURIComponent(rawId);
  const tz = ctx.settings.timezone;

  // A job number (search, shared links, "PJ-0042" typed into the URL) resolves to the id URL.
  if (JOB_NUMBER.test(id)) {
    let targetId: string | null = null;
    try {
      targetId = (await getJobRowByNumber(db, ctx, id)).id;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    if (targetId) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(sp)) {
        if (typeof v === "string") qs.set(k, v);
        else if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      }
      const query = qs.toString();
      redirect(`/jobs/${targetId}${query ? `?${query}` : ""}`);
    }
  }

  // Old tab links: the full audit log has its own page; every other tab is now a section of this one.
  if (param(sp, "tab") === "history" || param(sp, "view") === "history") redirect(`/jobs/${id}/history`);

  const page = await load(() => getJobPageSimple(db, ctx, id));
  const { header, files, permissions, sideColumn } = page;
  // The complete permission ref (draft window, past editors, project sharing) — docs/ROLES.md §2.1.
  const { ref } = await load(() => loadJobRef(db, ctx, header.id));
  const now = ctx.now();
  const isEditor = ctx.role === "editor";

  // Fine-grained bits the page model does not carry.
  const canAddRaw = allowed(ctx, "link.add", { job: ref, kind: "raw_files" });
  const otherKinds: LinkKind[] = SIMPLE_LINK_SLOTS.other.filter((kind) => allowed(ctx, "link.add", { job: ref, kind }));
  const instructionKind: NoteKind = isEditor ? "editor" : "photographer";
  const addInstructionsAs = allowed(ctx, "note.add", { job: ref, kind: instructionKind }) ? instructionKind : null;
  const privateKind = permissions.canAddPrivateNote ? (allowed(ctx, "note.add", { job: ref, kind: "internal" }) ? "internal" : "client") : null;
  const deletable: Record<string, boolean> = {};
  for (const c of flatten(page.messages)) {
    deletable[c.id] = c.deletedAt === null && allowed(ctx, "comment.delete", { job: ref, authorUserId: c.author.id, createdAt: c.createdAt, deletedAt: c.deletedAt, kind: c.kind });
  }
  const participants = [header.shotBy?.name, header.editedBy?.name].filter((n): n is string => Boolean(n));

  const back = isEditor ? { href: EDITOR_HOME_PATH, label: "Back to My jobs" } : { href: "/jobs", label: "Back to Jobs" };

  return (
    <PageContainer className="gap-5 pb-3 lg:pb-8">
      <JobHeaderSimple page={page} timeZone={tz} backHref={back.href} backLabel={back.label} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Desktop: the next step leads the page. On phones it is pinned at the bottom (below). */}
          <div className="hidden lg:block">
            <NextStepCard page={page} timeZone={tz} now={now} />
          </div>

          <FilesSection
            jobId={header.id}
            files={files}
            timeZone={tz}
            canAddRaw={canAddRaw}
            otherKindsAllowed={otherKinds}
            photographerName={header.shotBy?.name ?? null}
            editorName={header.editedBy?.name ?? null}
          />
          <InstructionsSection
            jobId={header.id}
            items={page.instructions}
            timeZone={tz}
            addAsKind={addInstructionsAs}
            editHref={permissions.canEditDetails ? `/jobs/${header.id}/edit` : null}
            viewerIsEditor={isEditor}
            photographerName={header.shotBy?.name ?? null}
          />
          {/* scroll-mt: the pinned bar's "See request" (phones) scrolls here. */}
          <ChangesAskedSection rounds={page.changesAsked} timeZone={tz} className="scroll-mt-4" />
          <MessagesThread
            jobId={header.id}
            messages={page.messages}
            canComment={permissions.canComment}
            deletable={deletable}
            timeZone={tz}
            viewerId={ctx.userId}
            participants={participants}
            viewerIsEditor={isEditor}
            photographerName={header.shotBy?.name ?? null}
          />
          {page.privateNotes !== null ? <PrivateNotes jobId={header.id} notes={page.privateNotes} addAsKind={privateKind} timeZone={tz} /> : null}
          {page.fromClient !== null ? (
            <FromClient jobId={header.id} clientName={header.client.name} threads={page.fromClient} deliveryNotes={page.deliveryNotes ?? []} canReply={permissions.canReplyToClient} timeZone={tz} />
          ) : null}
          <WhoDidWhat jobId={header.id} entries={page.whoDidWhat} timeZone={tz} />
        </div>

        <aside aria-label="Job details" className="min-w-0">
          <SideColumn side={sideColumn} timeZone={tz} jobId={header.id} version={header.version} clientName={header.client.name} canShare={permissions.canShareWithClient} className="lg:sticky lg:top-20" />
        </aside>
      </div>

      {/* Phones: the next step stays in reach at the bottom of the screen, above the tab bar. */}
      <div className="sticky bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px))] z-(--z-page-sticky) -mx-4 bg-canvas/85 px-4 pb-2 pt-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
        <NextStepCard page={page} timeZone={tz} now={now} pinned className="shadow-md" />
      </div>
    </PageContainer>
  );
}
