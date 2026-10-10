/**
 * Client portal reads (docs/ROLES.md §7.2, §7.4) and the staff-side sharing
 * read models (§7.1–§7.3, §11).
 *
 * PORTAL (client contexts):
 * - Every query starts from `portalJobsWhere(ctx)`; a job outside it is 404,
 *   never 403 (no existence oracle for other clients' or unshared work).
 * - Rows are projected ONLY through the whitelist mapper `toPortalJob()` /
 *   `portalDetail()`: never spread a DB row. Never in the projection: editors,
 *   status ids/names/categories, priority, due/review dates, revisions,
 *   internal/photographer/editor/client/revision notes, non-feedback comments,
 *   time tracking, assignment history, activity, other clients, emails.
 * - Links = CURRENT links with `shared_with_client = true` (none while cancelled).
 * - Feedback = `client_feedback` threads whose ROOT author is a user of the
 *   viewer's client (a previous client's threads stay staff-side, §4.5).
 *
 * STAFF (sharing controls): `getJobClientAccess`, `getProjectClientSharing`,
 * `getClientPortalAccess`, `getClientPreview` ("What the client sees").
 */
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { clients, jobComments, jobLinks, jobNotes, jobStatusTransitions, jobTypes, jobs, notifications, projects, users } from "@/db/schema";
import { CLIENT_NOTIFICATION_TYPES, type ClientNotificationType, type LinkKind, type StatusCategory } from "@/lib/constants";
import { clientMilestone, comparePortalJobs, isSafeExternalUrl } from "@/lib/portal";
import type {
  SharingFeedbackMessage,
  SharingFeedbackThread,
  ClientPortalAccess,
  JobClientAccess,
  ProjectClientSharing,
  SharingLink,
  SharingNote,
} from "@/lib/sharing";
import type {
  AuthContext,
  PortalFeedbackMessage,
  PortalFeedbackThread,
  PortalJob,
  PortalJobDetail,
  PortalJobRef,
  PortalLink,
  PortalNote,
  PortalProjectGroup,
} from "@/lib/types";
import { PortalJobsQuery } from "@/lib/validation/portal";
import { loadJobRef } from "@/server/auth/job-ref";
import { assertCan, can, isAssignedJob, isTeamViewJob, portalJobsWhere } from "@/server/auth/permissions";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { parseInput } from "@/server/services/_shared";

/* ------------------------------------------------------------------ */
/*  Row selection + whitelist mapper                                   */
/* ------------------------------------------------------------------ */

/** Latest transition into delivered/completed (null = never delivered). */
const lastDeliveredSql = sql<string | null>`(select max(${jobStatusTransitions.enteredAt}) from ${jobStatusTransitions}
  where ${jobStatusTransitions.jobId} = ${jobs.id} and ${jobStatusTransitions.toCategory} in ('delivered', 'completed'))`;

/** Everything the projection may read — and nothing more. */
const portalRowShape = {
  id: jobs.id,
  organisationId: jobs.organisationId,
  jobNumber: jobs.jobNumber,
  name: jobs.name,
  clientId: jobs.clientId,
  statusCategory: jobs.statusCategory,
  shootDate: jobs.shootDate,
  deliveryDueDate: jobs.deliveryDueDate,
  cancelledAt: jobs.cancelledAt,
  sharedWithClient: jobs.sharedWithClient,
  projectId: projects.id,
  projectName: projects.name,
  projectAddress: projects.address,
  projectShared: projects.sharedWithClient,
  jobTypeName: jobTypes.name,
  photographerName: users.name,
  lastDeliveredAt: lastDeliveredSql,
};

export interface PortalRow {
  id: string;
  organisationId: string;
  jobNumber: string;
  name: string;
  clientId: string;
  statusCategory: StatusCategory;
  shootDate: string | null;
  deliveryDueDate: string | null;
  cancelledAt: string | null;
  sharedWithClient: boolean;
  projectId: string;
  projectName: string;
  projectAddress: string | null;
  projectShared: boolean;
  jobTypeName: string;
  photographerName: string | null;
  lastDeliveredAt: string | null;
}

async function selectPortalRows(db: DbLike, where: SQL): Promise<PortalRow[]> {
  return db
    .select(portalRowShape)
    .from(jobs)
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
    .leftJoin(users, eq(users.id, jobs.photographerId))
    .where(where)
    .orderBy(asc(jobs.jobNumber));
}

/** The permission ref the portal rules evaluate (`portal.view_job`, `portal.give_feedback`). */
export function portalRefOf(row: PortalRow): PortalJobRef {
  return {
    id: row.id,
    organisationId: row.organisationId,
    clientId: row.clientId,
    sharedWithClient: row.sharedWithClient,
    projectSharedWithClient: row.projectShared,
    statusCategory: row.statusCategory,
    cancelledAt: row.cancelledAt,
  };
}

/** Whitelist mapper (§7.4). `now`/`timeZone` drive the Booked/Shot calendar-day rule. */
export function toPortalJob(row: PortalRow, now: string, timeZone: string): PortalJob {
  const m = clientMilestone(
    {
      category: row.statusCategory,
      shootDate: row.shootDate,
      everDelivered: row.lastDeliveredAt !== null,
      deliveredAt: row.lastDeliveredAt,
      cancelledAt: row.cancelledAt,
    },
    now,
    timeZone,
  );
  return {
    id: row.id,
    jobNumber: row.jobNumber,
    name: row.name,
    project: { id: row.projectId, name: row.projectName, address: row.projectAddress },
    jobTypeName: row.jobTypeName,
    milestone: m.milestone,
    milestoneLabel: m.label,
    milestoneDetail: m.detail,
    updating: m.updating,
    cancelled: m.cancelled,
    shootDate: row.shootDate,
    deliveryDueDate: row.deliveryDueDate,
    deliveredAt: m.milestone === "delivered" ? row.lastDeliveredAt : null,
    cancelledAt: m.cancelled ? row.cancelledAt : null,
    photographer: row.photographerName ? { name: row.photographerName } : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Detail parts (shared by the portal and the staff preview)          */
/* ------------------------------------------------------------------ */

async function clientVisibleLinks(db: DbLike, organisationId: string, jobId: string): Promise<PortalLink[]> {
  const rows = await db
    .select({ id: jobLinks.id, kind: jobLinks.kind, label: jobLinks.label, url: jobLinks.url, provider: jobLinks.provider })
    .from(jobLinks)
    .where(
      and(
        eq(jobLinks.organisationId, organisationId),
        eq(jobLinks.jobId, jobId),
        isNull(jobLinks.supersededAt),
        isNull(jobLinks.removedAt),
        eq(jobLinks.sharedWithClient, true),
      ),
    )
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
  return rows.filter((l) => isSafeExternalUrl(l.url)).map((l) => ({ id: l.id, kind: l.kind, label: l.label, url: l.url, provider: l.provider }));
}

async function deliveryNotesOf(db: DbLike, organisationId: string, jobId: string): Promise<PortalNote[]> {
  const rows = await db
    .select({ id: jobNotes.id, body: jobNotes.body, createdAt: jobNotes.createdAt, authorName: users.name })
    .from(jobNotes)
    .innerJoin(users, eq(users.id, jobNotes.authorUserId))
    .where(and(eq(jobNotes.organisationId, organisationId), eq(jobNotes.jobId, jobId), eq(jobNotes.kind, "delivery"), isNull(jobNotes.archivedAt)))
    .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id));
  return rows.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, authorName: n.authorName }));
}

interface FeedbackRow {
  id: string;
  parentCommentId: string | null;
  rootCommentId: string | null;
  authorUserId: string;
  authorName: string;
  authorRole: string;
  authorClientId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

async function feedbackRowsOf(db: DbLike, organisationId: string, jobId: string): Promise<FeedbackRow[]> {
  return db
    .select({
      id: jobComments.id,
      parentCommentId: jobComments.parentCommentId,
      rootCommentId: jobComments.rootCommentId,
      authorUserId: jobComments.authorUserId,
      authorName: users.name,
      authorRole: users.role,
      authorClientId: users.clientId,
      body: jobComments.body,
      createdAt: jobComments.createdAt,
      editedAt: jobComments.editedAt,
      deletedAt: jobComments.deletedAt,
    })
    .from(jobComments)
    .innerJoin(users, eq(users.id, jobComments.authorUserId))
    .where(and(eq(jobComments.organisationId, organisationId), eq(jobComments.jobId, jobId), eq(jobComments.kind, "client_feedback")))
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id));
}

function isRoot(r: FeedbackRow): boolean {
  return r.parentCommentId === null || r.rootCommentId === r.id;
}

/** Threads grouped by root (roots and replies oldest first). */
function groupThreads(rows: readonly FeedbackRow[], includeRoot: (root: FeedbackRow) => boolean): { root: FeedbackRow; replies: FeedbackRow[] }[] {
  const roots = rows.filter((r) => isRoot(r) && includeRoot(r));
  const byRoot = new Map(roots.map((r) => [r.id, { root: r, replies: [] as FeedbackRow[] }]));
  for (const r of rows) {
    if (isRoot(r)) continue;
    const thread = r.rootCommentId ? byRoot.get(r.rootCommentId) : undefined;
    if (thread) thread.replies.push(r);
  }
  return [...byRoot.values()];
}

function toPortalMessage(r: FeedbackRow): PortalFeedbackMessage {
  const deleted = r.deletedAt !== null;
  return {
    id: r.id,
    body: deleted ? "" : r.body,
    authorName: r.authorName,
    isClient: r.authorRole === "client",
    createdAt: r.createdAt,
    editedAt: deleted ? null : r.editedAt,
    deleted,
  };
}

/** Threads started by users of `clientId` (§7.4: the viewer's client only). */
async function portalFeedbackOf(db: DbLike, organisationId: string, jobId: string, clientId: string): Promise<PortalFeedbackThread[]> {
  const rows = await feedbackRowsOf(db, organisationId, jobId);
  return groupThreads(rows, (root) => root.authorRole === "client" && root.authorClientId === clientId).map(({ root, replies }) => ({
    ...toPortalMessage(root),
    replies: replies.map(toPortalMessage),
  }));
}

async function portalDetail(db: DbLike, row: PortalRow, clientId: string, now: string, timeZone: string, canGiveFeedback: boolean): Promise<PortalJobDetail> {
  const base = toPortalJob(row, now, timeZone);
  const links = base.cancelled ? [] : await clientVisibleLinks(db, row.organisationId, row.id);
  const deliveryNotes = await deliveryNotesOf(db, row.organisationId, row.id);
  const feedback = await portalFeedbackOf(db, row.organisationId, row.id, clientId);
  return { ...base, links, deliveryNotes, feedback, canGiveFeedback: canGiveFeedback && !base.cancelled };
}

/* ------------------------------------------------------------------ */
/*  Portal reads (client contexts)                                     */
/* ------------------------------------------------------------------ */

function assertPortal(ctx: AuthContext): asserts ctx is AuthContext & { clientId: string } {
  assertCan(ctx, "portal.access");
  if (ctx.clientId === null) throw new NotFoundError("Job");
}

/**
 * The client's visible job row + ref; anything outside `portalJobsWhere` → 404.
 * Used by every portal read and by the portal write services before they delegate.
 */
export async function loadPortalJob(db: DbLike, ctx: AuthContext, jobId: string): Promise<{ row: PortalRow; ref: PortalJobRef }> {
  assertPortal(ctx);
  const [row] = await selectPortalRows(db, and(eq(jobs.id, jobId), portalJobsWhere(ctx)) as SQL);
  if (!row) throw new NotFoundError("Job");
  const ref = portalRefOf(row);
  if (!can(ctx, "portal.view_job", ref)) throw new NotFoundError("Job");
  return { row, ref };
}

/** Every job the client can see (flat, sorted). */
export async function listPortalJobs(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<PortalJob[]> {
  assertPortal(ctx);
  const { sort } = parseInput(PortalJobsQuery, input ?? {});
  const rows = await selectPortalRows(db, portalJobsWhere(ctx));
  const tz = ctx.settings.timezone;
  const now = ctx.now();
  return rows
    .filter((r) => can(ctx, "portal.view_job", portalRefOf(r)))
    .map((r) => toPortalJob(r, now, tz))
    .sort(comparePortalJobs(sort ?? "progress"));
}

/** /portal: jobs grouped by project; groups with live work first, then by most recent date. */
export async function listPortalProjectGroups(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<PortalProjectGroup[]> {
  const jobsList = await listPortalJobs(db, ctx, input);
  const groups = new Map<string, PortalProjectGroup>();
  for (const job of jobsList) {
    const g = groups.get(job.project.id) ?? { project: job.project, jobs: [] };
    g.jobs.push(job);
    groups.set(job.project.id, g);
  }
  const live = (g: PortalProjectGroup) => g.jobs.some((j) => !j.cancelled && (j.milestone !== "delivered" || j.updating));
  const latest = (g: PortalProjectGroup): string => {
    let max = "";
    for (const j of g.jobs) {
      for (const d of [j.deliveredAt, j.shootDate]) if (d && d > max) max = d;
    }
    return max;
  };
  return [...groups.values()].sort((a, b) => {
    const l = Number(live(b)) - Number(live(a));
    if (l !== 0) return l;
    const d = latest(b).localeCompare(latest(a));
    return d !== 0 ? d : a.project.name.localeCompare(b.project.name);
  });
}

/** /portal/projects/[id]: the project's visible jobs; a project with none visible → 404. */
export async function getPortalProject(db: DbLike, ctx: AuthContext, projectId: string, input: unknown = {}): Promise<PortalProjectGroup> {
  const jobsList = (await listPortalJobs(db, ctx, input)).filter((j) => j.project.id === projectId);
  const head = jobsList[0];
  if (!head) throw new NotFoundError("Project");
  return { project: head.project, jobs: jobsList };
}

/** /portal/jobs/[id] and GET /api/portal/jobs/:id. */
export async function getPortalJob(db: DbLike, ctx: AuthContext, jobId: string): Promise<PortalJobDetail> {
  const { row, ref } = await loadPortalJob(db, ctx, jobId);
  return portalDetail(db, row, ctx.clientId as string, ctx.now(), ctx.settings.timezone, can(ctx, "portal.give_feedback", ref));
}

/** Ids of the viewer's own (not deleted) feedback messages on a portal job — drives Edit / Delete in the UI. */
export async function ownFeedbackIds(db: DbLike, ctx: AuthContext, jobId: string): Promise<string[]> {
  const { row } = await loadPortalJob(db, ctx, jobId);
  const rows = await db
    .select({ id: jobComments.id })
    .from(jobComments)
    .where(
      and(
        eq(jobComments.organisationId, ctx.organisationId),
        eq(jobComments.jobId, row.id),
        eq(jobComments.kind, "client_feedback"),
        eq(jobComments.authorUserId, ctx.userId as string),
        isNull(jobComments.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** /portal/account: the portal account's own name, email and row version. */
export async function getPortalProfile(db: DbLike, ctx: AuthContext): Promise<{ name: string; email: string; version: number }> {
  assertPortal(ctx);
  const row = await first(
    db
      .select({ name: users.name, email: users.email, version: users.version })
      .from(users)
      .where(and(eq(users.id, ctx.userId as string), eq(users.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("User");
  return row;
}

export interface PortalNotification {
  id: string;
  type: ClientNotificationType;
  title: string;
  body: string | null;
  /** Always a /portal path. */
  linkPath: string;
  readAt: string | null;
  createdAt: string;
}

const PORTAL_NOTIFICATION_LIMIT = 100;

function isClientType(t: string): t is ClientNotificationType {
  return (CLIENT_NOTIFICATION_TYPES as readonly string[]).includes(t);
}

/** The client's own notifications (client types only; links forced into /portal). */
export async function listPortalNotifications(db: DbLike, ctx: AuthContext, opts: { unreadOnly?: boolean } = {}): Promise<PortalNotification[]> {
  assertPortal(ctx);
  assertCan(ctx, "notification.read", { userId: ctx.userId as string, organisationId: ctx.organisationId });
  const parts: SQL[] = [
    eq(notifications.organisationId, ctx.organisationId),
    eq(notifications.userId, ctx.userId as string),
    inArray(notifications.type, [...CLIENT_NOTIFICATION_TYPES]),
  ];
  if (opts.unreadOnly) parts.push(isNull(notifications.readAt));
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPath: notifications.linkPath,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(...parts))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(PORTAL_NOTIFICATION_LIMIT);
  return rows.flatMap((n) =>
    isClientType(n.type)
      ? [{ id: n.id, type: n.type, title: n.title, body: n.body, linkPath: n.linkPath.startsWith("/portal") ? n.linkPath : "/portal", readAt: n.readAt, createdAt: n.createdAt }]
      : [],
  );
}

/** Unread client notifications (portal bell). */
export async function portalUnreadCount(db: DbLike, ctx: AuthContext): Promise<number> {
  if (ctx.role !== "client" || !ctx.userId) return 0;
  const row = await first(
    db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.organisationId, ctx.organisationId),
          eq(notifications.userId, ctx.userId),
          inArray(notifications.type, [...CLIENT_NOTIFICATION_TYPES]),
          isNull(notifications.readAt),
        ),
      ),
  );
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Staff: "What the client sees" preview                              */
/* ------------------------------------------------------------------ */

/**
 * The portal projection of a job exactly as its client's users would see it
 * (same mapper), for staff who can view the job. `visibleToClient` is false
 * when the job is not shared (directly or through its project) or the
 * client's portal is off / archived — the preview still renders so staff can
 * check before sharing.
 */
export async function getClientPreview(
  db: DbLike,
  ctx: AuthContext,
  jobId: string,
): Promise<{ job: PortalJobDetail; visibleToClient: boolean; clientName: string; portalEnabled: boolean }> {
  const { ref } = await loadJobRef(db, ctx, jobId);
  if (!can(ctx, "job.view", ref)) throw new NotFoundError("Job");
  const [row] = await selectPortalRows(db, and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId)) as SQL);
  if (!row) throw new NotFoundError("Job");
  const client = await first(
    db
      .select({ name: clients.name, portalEnabled: clients.portalEnabled, feedbackEnabled: clients.feedbackEnabled, archivedAt: clients.archivedAt })
      .from(clients)
      .where(and(eq(clients.id, row.clientId), eq(clients.organisationId, ctx.organisationId))),
  );
  const job = await portalDetail(db, row, row.clientId, ctx.now(), ctx.settings.timezone, false);
  const shared = row.sharedWithClient || row.projectShared;
  const portalOn = Boolean(client?.portalEnabled) && !client?.archivedAt;
  return { job, visibleToClient: shared && portalOn, clientName: client?.name ?? "", portalEnabled: portalOn };
}

/* ------------------------------------------------------------------ */
/*  Staff: job detail "Client access" card                             */
/* ------------------------------------------------------------------ */

function toSharingMessage(r: FeedbackRow): SharingFeedbackMessage {
  const deleted = r.deletedAt !== null;
  return {
    id: r.id,
    body: deleted ? null : r.body,
    authorName: r.authorName,
    isClient: r.authorRole === "client",
    createdAt: r.createdAt,
    editedAt: deleted ? null : r.editedAt,
    deleted,
  };
}

/**
 * Everything the "Client access" card shows. Null when the card is hidden
 * for this viewer: editors whose access is only past/created (read cut-off,
 * §2.3) never see client threads or sharing state.
 */
export async function getJobClientAccess(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobClientAccess | null> {
  const { job, ref } = await loadJobRef(db, ctx, jobId);
  if (!can(ctx, "job.view", ref)) throw new NotFoundError("Job");
  if (ctx.role === "editor" && !isAssignedJob(ctx, ref) && !isTeamViewJob(ctx, ref)) return null;

  const client = await first(
    db
      .select({
        id: clients.id,
        name: clients.name,
        portalEnabled: clients.portalEnabled,
        feedbackEnabled: clients.feedbackEnabled,
        archivedAt: clients.archivedAt,
      })
      .from(clients)
      .where(and(eq(clients.id, job.clientId), eq(clients.organisationId, ctx.organisationId))),
  );
  const project = await first(
    db
      .select({ id: projects.id, name: projects.name, sharedWithClient: projects.sharedWithClient })
      .from(projects)
      .where(and(eq(projects.id, job.projectId), eq(projects.organisationId, ctx.organisationId))),
  );
  if (!client || !project) throw new NotFoundError("Job");
  const portalUsers = await first(
    db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.organisationId, ctx.organisationId), eq(users.clientId, client.id), eq(users.isActive, true))),
  );

  // Current links with their visibility.
  const adder = users;
  const linkRows = await db
    .select({
      id: jobLinks.id,
      kind: jobLinks.kind,
      label: jobLinks.label,
      url: jobLinks.url,
      provider: jobLinks.provider,
      sharedWithClient: jobLinks.sharedWithClient,
      addedBySharer: jobLinks.addedBySharer,
      addedByUserId: jobLinks.addedByUserId,
      addedByName: adder.name,
      createdAt: jobLinks.createdAt,
    })
    .from(jobLinks)
    .innerJoin(adder, eq(adder.id, jobLinks.addedByUserId))
    .where(and(eq(jobLinks.organisationId, ctx.organisationId), eq(jobLinks.jobId, job.id), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
  const links: SharingLink[] = linkRows.map((l) => ({
    id: l.id,
    kind: l.kind as LinkKind,
    label: l.label,
    url: l.url,
    provider: l.provider,
    sharedWithClient: l.sharedWithClient,
    addedBySharer: l.addedBySharer,
    addedByName: l.addedByName,
    createdAt: l.createdAt,
    canShare: can(ctx, "link.share_with_client", {
      job: ref,
      kind: l.kind as LinkKind,
      addedByUserId: l.addedByUserId,
      isCurrent: true,
      sharedWithClient: l.sharedWithClient,
    }),
  }));

  // Delivery notes (readable by every staff persona that can see the job, §2.4).
  const canReadDelivery = can(ctx, "note.read", { job: ref, kind: "delivery" });
  let deliveryNotes: SharingNote[] = [];
  if (canReadDelivery) {
    const rows = await db
      .select({
        id: jobNotes.id,
        body: jobNotes.body,
        createdAt: jobNotes.createdAt,
        version: jobNotes.version,
        authorUserId: jobNotes.authorUserId,
        authorName: users.name,
      })
      .from(jobNotes)
      .innerJoin(users, eq(users.id, jobNotes.authorUserId))
      .where(and(eq(jobNotes.organisationId, ctx.organisationId), eq(jobNotes.jobId, job.id), eq(jobNotes.kind, "delivery"), isNull(jobNotes.archivedAt)))
      .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id));
    deliveryNotes = rows.map((n) => ({
      id: n.id,
      body: n.body,
      authorName: n.authorName,
      createdAt: n.createdAt,
      version: n.version,
      canEdit: can(ctx, "note.edit", { job: ref, kind: "delivery", authorUserId: n.authorUserId }),
      canArchive: can(ctx, "note.archive", { job: ref, kind: "delivery", authorUserId: n.authorUserId }),
    }));
  }

  // Client feedback threads (staff see every client thread on the job; old client's flagged).
  const feedbackRows = await feedbackRowsOf(db, ctx.organisationId, job.id);
  const feedback: SharingFeedbackThread[] = groupThreads(feedbackRows, () => true).map(({ root, replies }) => {
    const last = replies[replies.length - 1] ?? root;
    return {
      ...toSharingMessage(root),
      replies: replies.map(toSharingMessage),
      waiting: last.authorRole === "client" && last.deletedAt === null,
      fromOtherClient: root.authorRole === "client" && root.authorClientId !== client.id,
    };
  });

  const editorRow = job.editorId
    ? await first(
        db
          .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
          .from(users)
          .where(and(eq(users.id, job.editorId), eq(users.organisationId, ctx.organisationId))),
      )
    : undefined;

  return {
    jobId: job.id,
    jobNumber: job.jobNumber,
    jobVersion: job.version,
    statusCategory: job.statusCategory,
    editor: editorRow ?? null,
    client: {
      id: client.id,
      name: client.name,
      portalEnabled: client.portalEnabled,
      feedbackEnabled: client.feedbackEnabled,
      archived: client.archivedAt !== null,
      activePortalUsers: portalUsers?.n ?? 0,
    },
    project,
    sharedWithClient: job.sharedWithClient,
    visibleToClient: job.sharedWithClient || project.sharedWithClient,
    links,
    deliveryNotes,
    feedback,
    can: {
      shareJob: can(ctx, "job.share_with_client", ref),
      reply: can(ctx, "client_feedback.reply", ref),
      addDeliveryNote: can(ctx, "note.add", { job: ref, kind: "delivery" }),
      turnIntoRevision: can(ctx, "client_feedback.to_revision", ref) && can(ctx, "revision.request", ref),
      shareProject: can(ctx, "project.share_with_client", { organisationId: ctx.organisationId }),
      managePortal: can(ctx, "client.manage_portal", { organisationId: ctx.organisationId }),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Staff: project share switch, client portal card                    */
/* ------------------------------------------------------------------ */

/** Project page "Share every job in this project with the client". */
export async function getProjectClientSharing(db: DbLike, ctx: AuthContext, projectId: string): Promise<ProjectClientSharing> {
  assertCan(ctx, "app.access");
  const row = await first(
    db
      .select({
        id: projects.id,
        name: projects.name,
        version: projects.version,
        sharedWithClient: projects.sharedWithClient,
        createdByUserId: projects.createdByUserId,
        clientId: clients.id,
        clientName: clients.name,
        portalEnabled: clients.portalEnabled,
        clientArchivedAt: clients.archivedAt,
      })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(and(eq(projects.id, projectId), eq(projects.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("Project");
  // Photographers only (admins share; members see the state). Editors never see sharing state of a project.
  if (ctx.role !== "photographer") throw new ForbiddenError("project.share_with_client", "Only photographers can see project sharing");
  assertCan(ctx, "project.view", { organisationId: ctx.organisationId, createdByUserId: row.createdByUserId ?? undefined });
  const counts = await first(
    db
      .select({ total: count(), shared: sql<number>`count(*) filter (where ${jobs.sharedWithClient} = true)`.mapWith(Number) })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.projectId, row.id))),
  );
  return {
    projectId: row.id,
    projectName: row.name,
    version: row.version,
    sharedWithClient: row.sharedWithClient,
    client: { id: row.clientId, name: row.clientName, portalEnabled: row.portalEnabled, archived: row.clientArchivedAt !== null },
    jobCount: counts?.total ?? 0,
    individuallySharedJobs: counts?.shared ?? 0,
    canShare: can(ctx, "project.share_with_client", { organisationId: ctx.organisationId }),
  };
}

/** Client page "Client portal" card (admin: `client.manage_portal`). */
export async function getClientPortalAccess(db: DbLike, ctx: AuthContext, clientId: string): Promise<ClientPortalAccess> {
  const row = await first(
    db
      .select({
        id: clients.id,
        name: clients.name,
        version: clients.version,
        portalEnabled: clients.portalEnabled,
        feedbackEnabled: clients.feedbackEnabled,
        archivedAt: clients.archivedAt,
      })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("Client");
  assertCan(ctx, "client.manage_portal", { organisationId: ctx.organisationId });
  const portalUsers = await db
    .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive, lastLoginAt: users.lastLoginAt, version: users.version })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.role, "client"), eq(users.clientId, row.id), isNull(users.anonymisedAt)))
    .orderBy(desc(users.isActive), asc(sql`lower(${users.name})`), asc(users.id));
  const sharedProjects = await first(
    db
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.organisationId, ctx.organisationId), eq(projects.clientId, row.id), eq(projects.sharedWithClient, true))),
  );
  const sharedJobs = await first(
    db
      .select({ n: count() })
      .from(jobs)
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .where(
        and(
          eq(jobs.organisationId, ctx.organisationId),
          eq(jobs.clientId, row.id),
          sql`(${jobs.sharedWithClient} = true or ${projects.sharedWithClient} = true)`,
        ),
      ),
  );
  return {
    clientId: row.id,
    clientName: row.name,
    version: row.version,
    portalEnabled: row.portalEnabled,
    feedbackEnabled: row.feedbackEnabled,
    archived: row.archivedAt !== null,
    users: portalUsers,
    sharedProjectCount: sharedProjects?.n ?? 0,
    sharedJobCount: sharedJobs?.n ?? 0,
  };
}
