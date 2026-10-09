import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { PageContainer } from "@/components/shell";
import {
  ActivityTab,
  CommentsTab,
  FactsRail,
  HistoryTab,
  JobHeader,
  JobTabs,
  LinksTab,
  NotesTab,
  OverviewTab,
  RevisionsTab,
  TimeTab,
  TimelineTab,
  ACTIVITY_GROUPS,
  isActivityGroup,
  isJobTab,
  type ActivityGroup,
  type JobTab,
  type LinkPermissions,
  type NotePermissions,
} from "@/components/job-detail";
import { NOTE_KINDS, type NoteKind } from "@/lib/constants";
import type { CommentNode, JobDetail, JobPermissionRef } from "@/lib/types";
import { allowed, load, pageContext, param } from "@/server/page";
import { NotFoundError } from "@/server/errors";
import { getJobDetail } from "@/server/queries/jobDetail";
import { getJobActivity, getJobHistory, getJobTimeline } from "@/server/queries/jobHistory";
import { getJobRowByNumber, getJobRowsByIds } from "@/server/queries/jobs";

/** "PJ-0042", "pj-42" — a human job number rather than an id. */
const JOB_NUMBER = /^[A-Za-z]{1,8}-\d{1,8}$/;

export async function generateMetadata({ params }: PageProps<"/jobs/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const { ctx, db } = await pageContext();
    const row = JOB_NUMBER.test(id) ? getJobRowByNumber(db, ctx, id) : getJobRowsByIds(db, ctx, [id])[0];
    return { title: row ? `${row.jobNumber} · ${row.name}` : "Job" };
  } catch {
    return { title: "Job" };
  }
}

/** Facts the permission layer needs, rebuilt from the detail bundle (no extra query). */
function permissionRef(detail: JobDetail, organisationId: string, role: string): JobPermissionRef {
  const { job } = detail;
  const pastEditorIds = [...new Set(detail.assignments.filter((a) => a.role === "editor").map((a) => a.user.id))];
  return {
    id: job.id,
    organisationId,
    photographerId: job.photographer?.id ?? null,
    editorId: job.editor?.id ?? null,
    createdByUserId: job.createdBy.id,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
    ...(role === "editor" ? { pastEditorIds } : {}),
  };
}

function flattenComments(nodes: readonly CommentNode[]): CommentNode[] {
  return nodes.flatMap((n) => [n, ...flattenComments(n.replies)]);
}

export default async function JobDetailPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const [{ id: rawId }, sp] = await Promise.all([params, searchParams]);
  const { ctx, db } = await pageContext();
  const id = decodeURIComponent(rawId);
  const tz = ctx.settings.timezone;

  // A job number (search, shared links, "PJ-0042" typed into the URL) resolves to the id URL.
  if (JOB_NUMBER.test(id)) {
    let targetId: string | null = null;
    try {
      targetId = getJobRowByNumber(db, ctx, id).id;
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

  const detail = load(() => getJobDetail(db, ctx, id));
  const { job, actions } = detail;
  const ref = permissionRef(detail, ctx.organisationId, ctx.role);
  const isManagement = ctx.role === "owner" || ctx.role === "manager";

  // Tabs available to this viewer.
  const showTime = ctx.settings.timeTrackingEnabled || detail.sessions.length > 0;
  const readableNoteKinds: NoteKind[] = NOTE_KINDS.filter((kind) => allowed(ctx, "note.read", { job: ref, kind }));
  const commentCount = flattenComments(detail.comments).filter((c) => c.deletedAt === null).length;
  const tabs: { key: JobTab; count?: number }[] = [
    { key: "overview" },
    { key: "links", count: detail.links.filter((s) => s.current).length },
    { key: "notes", count: detail.notes.filter((n) => n.archivedAt === null).length },
    { key: "comments", count: commentCount },
    { key: "revisions", count: detail.revisions.length },
    { key: "timeline" },
    { key: "activity" },
    { key: "history" },
    ...(showTime ? [{ key: "time" as const, count: detail.sessions.length }] : []),
  ];
  const requested = param(sp, "tab");
  const active: JobTab = isJobTab(requested) && tabs.some((t) => t.key === requested) ? requested : "overview";

  let panel: ReactNode;
  switch (active) {
    case "links": {
      const permissions: Record<string, LinkPermissions> = {};
      for (const slot of detail.links) {
        const l = slot.current;
        if (!l) continue;
        const res = { job: ref, kind: l.kind, addedByUserId: l.addedBy.id };
        permissions[l.id] = { canReplace: allowed(ctx, "link.replace", res), canRemove: allowed(ctx, "link.remove", res) };
      }
      panel = <LinksTab jobId={job.id} slots={detail.links} canAddKinds={actions.canAddLinkKinds} permissions={permissions} timeZone={tz} />;
      break;
    }
    case "notes": {
      const permissions: Record<string, NotePermissions> = {};
      for (const n of detail.notes) {
        const res = { job: ref, kind: n.kind, authorUserId: n.author.id };
        permissions[n.id] = { canEdit: allowed(ctx, "note.edit", res), canArchive: allowed(ctx, "note.archive", res) };
      }
      const kind = param(sp, "kind");
      panel = (
        <NotesTab
          jobId={job.id}
          notes={detail.notes}
          readableKinds={readableNoteKinds}
          canAddKinds={actions.canAddNoteKinds}
          permissions={permissions}
          timeZone={tz}
          initialKind={kind && (NOTE_KINDS as readonly string[]).includes(kind) ? (kind as NoteKind) : null}
        />
      );
      break;
    }
    case "comments": {
      const deletable: Record<string, boolean> = {};
      for (const c of flattenComments(detail.comments)) {
        deletable[c.id] = c.deletedAt === null && allowed(ctx, "comment.delete", { job: ref, authorUserId: c.author.id, createdAt: c.createdAt, deletedAt: c.deletedAt });
      }
      panel = (
        <CommentsTab
          jobId={job.id}
          comments={detail.comments}
          revisions={detail.revisions}
          canComment={actions.canComment}
          deletable={deletable}
          timeZone={tz}
          respondTo={param(sp, "respond") ?? null}
          autoFocus={param(sp, "compose") === "1"}
        />
      );
      break;
    }
    case "revisions":
      panel = (
        <RevisionsTab
          jobId={job.id}
          jobVersion={job.version}
          revisions={detail.revisions}
          comments={detail.comments}
          timeZone={tz}
          canEditOpen={allowed(ctx, "revision.request", ref)}
          canWithdraw={actions.canWithdrawRevision}
          canRespond={actions.canComment}
        />
      );
      break;
    case "timeline": {
      let timeline = null;
      try {
        timeline = getJobTimeline(db, ctx, job.id);
      } catch {
        timeline = null; // bottleneck flags are an enhancement; the stages come from the detail.
      }
      panel = <TimelineTab stages={detail.stages} timeline={timeline} timeZone={tz} now={ctx.now()} />;
      break;
    }
    case "activity": {
      const groups = (param(sp, "events") ?? "").split(",").filter(isActivityGroup) as ActivityGroup[];
      const eventType = groups.flatMap((g) => [...ACTIVITY_GROUPS[g].types]);
      const initial = load(() => getJobActivity(db, ctx, job.id, { limit: 50, ...(eventType.length > 0 ? { eventType } : {}) }));
      panel = <ActivityTab key={groups.join(",")} jobId={job.id} initial={initial} groups={groups} timeZone={tz} />;
      break;
    }
    case "history": {
      const entries = load(() => getJobHistory(db, ctx, job.id));
      panel = <HistoryTab entries={entries} timeZone={tz} current={job.status} />;
      break;
    }
    case "time":
      panel = <TimeTab sessions={detail.sessions} timeZone={tz} timeTrackingEnabled={ctx.settings.timeTrackingEnabled} ownOnly={!allowed(ctx, "timer.view_others", ref)} />;
      break;
    default:
      panel = <OverviewTab detail={detail} timeZone={tz} readableNoteKinds={readableNoteKinds} />;
  }

  return (
    <PageContainer className="gap-0 pb-36 lg:pb-8">
      <JobHeader
        detail={detail}
        timeZone={tz}
        canOverride={allowed(ctx, "job.transition_override", ref)}
        linkPeople={isManagement}
        viewerId={ctx.userId}
        timeTrackingEnabled={ctx.settings.timeTrackingEnabled}
      />
      {/* Facts sit beside the tabs only at xl (≥1280); narrower, the tab column keeps the full width and the facts follow below. */}
      <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <JobTabs active={active} tabs={tabs} editHref={actions.canEditFields ? `/jobs/${job.id}/edit` : null}>
            {panel}
          </JobTabs>
        </div>
        <aside aria-label="Job facts" className="min-w-0 xl:pt-1">
          <FactsRail detail={detail} timeZone={tz} viewerId={ctx.userId} timeTrackingEnabled={ctx.settings.timeTrackingEnabled} />
        </aside>
      </div>
    </PageContainer>
  );
}
