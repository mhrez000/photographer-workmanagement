/**
 * Client sharing + portal switches (docs/ROLES.md §3.5, §7.1–§7.3, §7.6).
 *
 * The ONLY writers of `jobs.shared_with_client`, `projects.shared_with_client`,
 * `job_links.shared_with_client`, `clients.portal_enabled` and
 * `clients.feedback_enabled` (besides the migration and `addLink` /
 * `replaceLink` / `updateLink` insert-time values):
 *
 *   - `shareJob`        POST /api/jobs/:id/share      `job.share_with_client`   → job.client_sharing_changed
 *   - `shareProject`    POST /api/projects/:id/share  `project.share_with_client` (admin) → project.client_sharing_changed
 *   - `shareLink`       POST /api/links/:id/share     `link.share_with_client` (current links only) → link.client_sharing_changed
 *   - `setClientPortal` POST /api/clients/:id/portal  `client.manage_portal` (admin) → client.portal_updated
 *   - `runDeliveryStep` the delivery step of a delivering move (called by `applyMove`, same tx)
 *   - `resetSharingForClientChange` the client-change reset of `applyJobFieldChanges` (§4.5)
 *
 * Every write is version-checked where the table has a version, audited in the
 * same transaction, and permission-checked. Sharing events carry the business
 * reason in `metadata.reason` ∈ SHARING_REASONS (the actor cause stays in
 * `metadata.cause`). Client notifications (`client_work_shared`,
 * `client_work_delivered`) go only to active portal users of a client whose
 * portal is on and that is not archived.
 *
 * This module never imports ./workflow (the engine imports it).
 */
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import { first, type DbLike, type Tx } from "@/db/index";
import { clients, jobLinks, jobNotes, jobs, projects, users } from "@/db/schema";
import type { LinkKind, SharingReason } from "@/lib/constants";
import type { AuthContext, Client, Job, JobLink, JobNote, JobPermissionRef, Project } from "@/lib/types";
import { ShareJobInput, type DeliveryInputValue } from "@/lib/validation/jobs";
import { ShareLinkInput } from "@/lib/validation/links";
import { SetClientPortalInput, ShareProjectInput } from "@/lib/validation/sharing";
import { assertCan, can } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ConflictError, ValidationError } from "@/server/errors";
import { jobMeta, loadJobWithRef } from "./_collab";
import { assertVersion, loadClientInOrg, loadLinkInOrg, loadProjectInOrg, parseInput } from "./_shared";
import { notify } from "./notifications";

/** Link kinds a non-dialog delivery shares by default (when added by someone who could share, §7.3). */
export const DEFAULT_DELIVERY_SHARE_KINDS: readonly LinkKind[] = ["gallery", "client_delivery"];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isCurrentLink(link: Pick<JobLink, "supersededAt" | "removedAt">): boolean {
  return link.supersededAt === null && link.removedAt === null;
}

/** The job is visible in its client's portal: shared itself or through its project (cancel window aside). */
export function isClientVisible(job: Pick<Job, "sharedWithClient">, ref: Pick<JobPermissionRef, "projectSharedWithClient">): boolean {
  return job.sharedWithClient || ref.projectSharedWithClient;
}

/**
 * Active portal users of `clientId` — only while the client's portal is on and
 * the client is not archived (they could not sign in otherwise).
 */
export async function clientPortalUserIds(db: DbLike, organisationId: string, clientId: string): Promise<string[]> {
  const client = await first(
    db
      .select({ portalEnabled: clients.portalEnabled, archivedAt: clients.archivedAt })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.organisationId, organisationId))),
  );
  if (!client || !client.portalEnabled || client.archivedAt !== null) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organisationId, organisationId), eq(users.clientId, clientId), eq(users.role, "client"), eq(users.isActive, true)))
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

function portalJobPath(jobId: string): string {
  return `/portal/jobs/${jobId}`;
}

/** `UPDATE jobs SET shared_with_client …, version + 1 WHERE version = ?` (409 on a stale row). */
async function updateJobShared(tx: Tx, ctx: AuthContext, job: Job, shared: boolean): Promise<Job> {
  const row = await first(
    tx
      .update(jobs)
      .set({ sharedWithClient: shared, version: job.version + 1, updatedAt: ctx.now() })
      .where(and(eq(jobs.id, job.id), eq(jobs.organisationId, job.organisationId), eq(jobs.version, job.version)))
      .returning(),
  );
  if (!row) throw new ConflictError(undefined, await first(tx.select().from(jobs).where(eq(jobs.id, job.id))));
  return row;
}

/** The `job.client_sharing_changed` event (the caller already wrote the column). */
async function recordJobSharing(tx: Tx, ctx: AuthContext, job: Job, from: boolean, to: boolean, reason: SharingReason, extra: Record<string, unknown> = {}): Promise<string> {
  return recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.client_sharing_changed",
    action: "updated",
    previousValue: { shared: from },
    newValue: { shared: to },
    metadata: { reason, clientId: job.clientId, ...jobMeta(job), ...extra },
  });
}

/**
 * Sets `jobs.shared_with_client` (version + 1) and audits it. No-op (null) when
 * unchanged. Callers check `job.share_with_client`.
 */
export async function setJobSharedTx(tx: Tx, ctx: AuthContext, job: Job, shared: boolean, reason: SharingReason): Promise<{ job: Job; eventId: string | null }> {
  if (job.sharedWithClient === shared) return { job, eventId: null };
  const updated = await updateJobShared(tx, ctx, job, shared);
  const eventId = await recordJobSharing(tx, ctx, updated, job.sharedWithClient, shared, reason);
  return { job: updated, eventId };
}

/**
 * Sets `job_links.shared_with_client` on a CURRENT link (the 0003 guard freezes
 * it once superseded / removed) and audits it. No-op (null) when unchanged.
 * Callers check `link.share_with_client`.
 */
export async function setLinkSharedTx(
  tx: Tx,
  ctx: AuthContext,
  link: JobLink,
  job: Pick<Job, "id" | "jobNumber" | "name">,
  shared: boolean,
  reason: SharingReason,
): Promise<string | null> {
  if (link.sharedWithClient === shared) return null;
  const updated = await first(
    tx
      .update(jobLinks)
      .set({ sharedWithClient: shared })
      .where(and(eq(jobLinks.id, link.id), eq(jobLinks.organisationId, ctx.organisationId), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
      .returning({ id: jobLinks.id }),
  );
  if (!updated) throw new ConflictError("This link was changed by someone else. Reload and try again.", await loadLinkInOrg(tx, ctx, link.id));
  return recordEvent(tx, ctx, {
    entityType: "link",
    entityId: link.id,
    jobId: job.id,
    eventType: "link.client_sharing_changed",
    action: "updated",
    previousValue: { shared: link.sharedWithClient },
    newValue: { shared },
    metadata: { reason, linkId: link.id, kind: link.kind, url: link.url, label: link.label, ...jobMeta(job) },
  });
}

async function currentJobLinks(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobLink[]> {
  return db
    .select()
    .from(jobLinks)
    .where(and(eq(jobLinks.jobId, jobId), eq(jobLinks.organisationId, ctx.organisationId), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
}

/** `client_work_shared` / `client_work_delivered` to every portal user of the job's client (one per user). */
async function notifyClientUsers(
  tx: Tx,
  ctx: AuthContext,
  job: Pick<Job, "id" | "name" | "clientId">,
  type: "client_work_shared" | "client_work_delivered",
  activityEventId: string | null,
  dedupe: string,
): Promise<string[]> {
  const recipients = await clientPortalUserIds(tx, ctx.organisationId, job.clientId);
  const sent: string[] = [];
  for (const userId of recipients) {
    const res = await notify(tx, ctx, {
      userIds: [userId],
      type,
      title: type === "client_work_delivered" ? `Your work is ready: ${job.name}` : `${job.name} is now available`,
      jobId: job.id,
      activityEventId,
      linkPath: portalJobPath(job.id),
      dedupeKey: `${dedupe}:${userId}`,
    });
    sent.push(...res.recipientIds);
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/*  shareJob / shareLink                                               */
/* ------------------------------------------------------------------ */

export interface ShareJobResult {
  job: Job;
  changed: boolean;
  eventId: string | null;
  /** Client users told about the newly visible job. */
  notifiedUserIds: string[];
}

/** `POST /api/jobs/:id/share { shared, expectedVersion }` — `job.share_with_client` (admin; member managed ∧ ⚑review). */
export async function shareJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<ShareJobResult> {
  const p = parseInput(ShareJobInput, input);
  const { job, ref } = await loadJobWithRef(tx, ctx, p.jobId);
  assertCan(ctx, "job.share_with_client", ref);
  assertVersion(job, p.expectedVersion);
  const wasVisible = isClientVisible(job, ref);
  const res = await setJobSharedTx(tx, ctx, job, p.shared, "manual");
  let notifiedUserIds: string[] = [];
  if (res.eventId && p.shared && !wasVisible) {
    notifiedUserIds = await notifyClientUsers(tx, ctx, res.job, "client_work_shared", res.eventId, `client_shared:${job.id}:${res.eventId}`);
  }
  return { job: res.job, changed: res.eventId !== null, eventId: res.eventId, notifiedUserIds };
}

export interface ShareLinkResult {
  link: JobLink;
  changed: boolean;
  eventId: string | null;
}

/** `POST /api/links/:id/share { shared }` — current links only (422 otherwise); `link.share_with_client`. */
export async function shareLink(tx: Tx, ctx: AuthContext, input: unknown): Promise<ShareLinkResult> {
  const p = parseInput(ShareLinkInput, input);
  const link = await loadLinkInOrg(tx, ctx, p.linkId);
  const { job, ref } = await loadJobWithRef(tx, ctx, link.jobId);
  if (!isCurrentLink(link)) {
    throw new ValidationError(
      link.removedAt ? "This link was removed; only current links can be shared" : "This link was replaced; share the current link instead",
    );
  }
  assertCan(ctx, "link.share_with_client", {
    job: ref,
    kind: link.kind,
    addedByUserId: link.addedByUserId,
    isCurrent: true,
    sharedWithClient: link.sharedWithClient,
  });
  const eventId = await setLinkSharedTx(tx, ctx, link, job, p.shared, "manual");
  const fresh = eventId ? await loadLinkInOrg(tx, ctx, link.id) : link;
  return { link: fresh, changed: eventId !== null, eventId };
}

/* ------------------------------------------------------------------ */
/*  shareProject / setClientPortal (admin)                             */
/* ------------------------------------------------------------------ */

export interface ShareProjectResult {
  project: Project;
  changed: boolean;
  eventId: string | null;
  /** Jobs of the project (any status) at the time of the change. */
  jobCount: number;
  notifiedUserIds: string[];
}

/**
 * `POST /api/projects/:id/share { shared, expectedVersion }` — admin. A shared
 * project shares every current and future job; unsharing hides the jobs that
 * are not shared individually.
 */
export async function shareProject(tx: Tx, ctx: AuthContext, input: unknown): Promise<ShareProjectResult> {
  const p = parseInput(ShareProjectInput, input);
  const project = await loadProjectInOrg(tx, ctx, p.projectId);
  assertCan(ctx, "project.share_with_client", { organisationId: project.organisationId, createdByUserId: project.createdByUserId ?? undefined });
  assertVersion(project, p.expectedVersion);
  const jobCount = (await first(tx.select({ n: count() }).from(jobs).where(and(eq(jobs.projectId, project.id), eq(jobs.organisationId, ctx.organisationId)))))?.n ?? 0;
  if (project.sharedWithClient === p.shared) return { project, changed: false, eventId: null, jobCount, notifiedUserIds: [] };

  const updated = await first(
    tx
      .update(projects)
      .set({ sharedWithClient: p.shared, version: project.version + 1, updatedAt: ctx.now() })
      .where(and(eq(projects.id, project.id), eq(projects.organisationId, ctx.organisationId), eq(projects.version, project.version)))
      .returning(),
  );
  if (!updated) throw new ConflictError(undefined, await loadProjectInOrg(tx, ctx, project.id));
  const eventId = await recordEvent(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    eventType: "project.client_sharing_changed",
    action: "updated",
    previousValue: { shared: project.sharedWithClient },
    newValue: { shared: p.shared },
    metadata: { reason: "manual", projectId: project.id, projectName: project.name, clientId: project.clientId, jobCount },
  });

  const notifiedUserIds: string[] = [];
  if (p.shared) {
    const live = (
      await first(
        tx
          .select({ n: count() })
          .from(jobs)
          .where(and(eq(jobs.projectId, project.id), eq(jobs.organisationId, ctx.organisationId), ne(jobs.statusCategory, "cancelled"))),
      )
    )?.n ?? 0;
    if (live > 0) {
      for (const userId of await clientPortalUserIds(tx, ctx.organisationId, project.clientId)) {
        const res = await notify(tx, ctx, {
          userIds: [userId],
          type: "client_work_shared",
          title: live === 1 ? `1 job at ${project.name} is now available` : `${live} jobs at ${project.name} are now available`,
          activityEventId: eventId,
          linkPath: "/portal",
          dedupeKey: `client_project_shared:${project.id}:${eventId}:${userId}`,
        });
        notifiedUserIds.push(...res.recipientIds);
      }
    }
  }
  return { project: updated, changed: true, eventId, jobCount, notifiedUserIds };
}

export interface SetClientPortalResult {
  client: Client;
  /** Changed switch names (`portalEnabled`, `feedbackEnabled`). */
  changed: string[];
  eventId: string | null;
}

/**
 * `POST /api/clients/:id/portal { portalEnabled?, feedbackEnabled?, expectedVersion }`
 * — admin. Turning the portal off signs its users out at their next request
 * (their context resolves to null); no session bump needed.
 */
export async function setClientPortal(tx: Tx, ctx: AuthContext, input: unknown): Promise<SetClientPortalResult> {
  const p = parseInput(SetClientPortalInput, input);
  const client = await loadClientInOrg(tx, ctx, p.clientId);
  assertCan(ctx, "client.manage_portal", { organisationId: client.organisationId, createdByUserId: client.createdByUserId ?? undefined });
  assertVersion(client, p.expectedVersion);
  const patch: Partial<Pick<Client, "portalEnabled" | "feedbackEnabled">> = {};
  if (p.portalEnabled !== undefined && p.portalEnabled !== client.portalEnabled) patch.portalEnabled = p.portalEnabled;
  if (p.feedbackEnabled !== undefined && p.feedbackEnabled !== client.feedbackEnabled) patch.feedbackEnabled = p.feedbackEnabled;
  const changed = Object.keys(patch);
  if (changed.length === 0) return { client, changed, eventId: null };

  const updated = await first(
    tx
      .update(clients)
      .set({ ...patch, version: client.version + 1, updatedAt: ctx.now() })
      .where(and(eq(clients.id, client.id), eq(clients.organisationId, ctx.organisationId), eq(clients.version, client.version)))
      .returning(),
  );
  if (!updated) throw new ConflictError(undefined, await loadClientInOrg(tx, ctx, client.id));
  const eventId = await recordEvent(tx, ctx, {
    entityType: "client",
    entityId: client.id,
    eventType: "client.portal_updated",
    action: "updated",
    previousValue: { portalEnabled: client.portalEnabled, feedbackEnabled: client.feedbackEnabled },
    newValue: { portalEnabled: updated.portalEnabled, feedbackEnabled: updated.feedbackEnabled },
    metadata: { clientId: client.id, clientName: client.name, changed },
  });
  return { client: updated, changed, eventId };
}

/* ------------------------------------------------------------------ */
/*  Delivery step (inside applyMove, same transaction)                 */
/* ------------------------------------------------------------------ */

export interface DeliveryStepResult {
  job: Job;
  /** The job became shared by this step. */
  jobShared: boolean;
  /** Links newly shared by this step. */
  sharedLinkIds: string[];
  /** The job is client-visible after the step. */
  clientVisible: boolean;
  /** Current client-visible links after the step. */
  visibleLinkCount: number;
  notifiedUserIds: string[];
}

/**
 * The delivery step of a delivering move (docs/ROLES.md §7.3): runs after the
 * job entered `delivered` (or `completed` without a prior delivery).
 *
 * - `delivery.shareJob` → shares the job (`job.share_with_client`), reason "delivered".
 * - If the job is client-visible afterwards: shares `delivery.shareLinkIds`
 *   (each a current link of this job, `link.share_with_client`) or, without a
 *   selection, the DEFAULT set = current gallery / client_delivery links with
 *   `added_by_sharer = true` (never an editor's unreviewed upload).
 * - A client-visible job notifies its portal users `client_work_delivered`
 *   (dedupe `client_delivered:<jobId>:<userId>:<transitionId>`).
 * Explicit link ids on a job that stays hidden → 422 (nothing would publish them).
 */
export async function runDeliveryStep(
  tx: Tx,
  ctx: AuthContext,
  jobIn: Job,
  ref: JobPermissionRef,
  delivery: DeliveryInputValue | null | undefined,
  transitionId: string,
): Promise<DeliveryStepResult> {
  let job = jobIn;
  let jobShared = false;
  if (delivery?.shareJob === true && !job.sharedWithClient) {
    assertCan(ctx, "job.share_with_client", ref);
    const res = await setJobSharedTx(tx, ctx, job, true, "delivered");
    job = res.job;
    jobShared = res.eventId !== null;
  }
  const clientVisible = isClientVisible(job, ref);
  const explicit = delivery?.shareLinkIds;
  const sharedLinkIds: string[] = [];
  const current = await currentJobLinks(tx, ctx, job.id);

  if (!clientVisible) {
    if (explicit && explicit.length > 0) {
      throw new ValidationError("Share the job with the client to publish its links", {
        formErrors: [],
        fieldErrors: { "delivery.shareLinkIds": ["The job is not shared with the client"] },
      });
    }
    return { job, jobShared, sharedLinkIds, clientVisible, visibleLinkCount: 0, notifiedUserIds: [] };
  }

  let targets: JobLink[];
  if (explicit !== undefined) {
    const byId = new Map(current.map((l) => [l.id, l]));
    targets = [];
    for (const id of Array.from(new Set(explicit))) {
      const link = byId.get(id);
      if (!link) {
        throw new ValidationError("Only current links of this job can be shared", {
          formErrors: [],
          fieldErrors: { "delivery.shareLinkIds": [`Link ${id} is not a current link of this job`] },
        });
      }
      assertCan(ctx, "link.share_with_client", { job: ref, kind: link.kind, addedByUserId: link.addedByUserId, isCurrent: true, sharedWithClient: link.sharedWithClient });
      targets.push(link);
    }
  } else {
    targets = current.filter((l) => DEFAULT_DELIVERY_SHARE_KINDS.includes(l.kind) && l.addedBySharer);
  }
  for (const link of targets) {
    if (await setLinkSharedTx(tx, ctx, link, job, true, "delivered")) sharedLinkIds.push(link.id);
  }
  const shared = new Set(sharedLinkIds);
  const visibleLinkCount = current.filter((l) => l.sharedWithClient || shared.has(l.id)).length;
  const notifiedUserIds = await notifyClientUsers(tx, ctx, job, "client_work_delivered", null, `client_delivered:${job.id}:${transitionId}`);
  return { job, jobShared, sharedLinkIds, clientVisible, visibleLinkCount, notifiedUserIds };
}

/* ------------------------------------------------------------------ */
/*  Client change reset (applyJobFieldChanges, §4.5)                   */
/* ------------------------------------------------------------------ */

export interface ClientChangeResetResult {
  unsharedLinkIds: string[];
  archivedNoteIds: string[];
  jobEventId: string | null;
}

/**
 * After a job moved to another CLIENT (the caller's UPDATE already set
 * `shared_with_client = false`): audits the job unshare, unshares every current
 * shared link and archives every non-archived `delivery` note, all with
 * `metadata.reason = "client_changed"`. Nothing of the old client's portal view
 * follows the job to the new client.
 */
export async function resetSharingForClientChange(tx: Tx, ctx: AuthContext, before: Job, after: Job): Promise<ClientChangeResetResult> {
  const reason: SharingReason = "client_changed";
  const jobEventId = before.sharedWithClient
    ? await recordJobSharing(tx, ctx, after, true, false, reason, { previousClientId: before.clientId })
    : null;

  const unsharedLinkIds: string[] = [];
  const shared = (await currentJobLinks(tx, ctx, after.id)).filter((l) => l.sharedWithClient);
  for (const link of shared) {
    if (await setLinkSharedTx(tx, ctx, link, after, false, reason)) unsharedLinkIds.push(link.id);
  }

  const archivedNoteIds: string[] = [];
  const notes: JobNote[] = await tx
    .select()
    .from(jobNotes)
    .where(and(eq(jobNotes.jobId, after.id), eq(jobNotes.organisationId, ctx.organisationId), eq(jobNotes.kind, "delivery"), isNull(jobNotes.archivedAt)))
    .orderBy(asc(jobNotes.createdAt), asc(jobNotes.id));
  const at = ctx.now();
  for (const note of notes) {
    const updated = await first(
      tx
        .update(jobNotes)
        .set({ archivedAt: at, archivedByUserId: ctx.userId, updatedAt: at, version: note.version + 1 })
        .where(and(eq(jobNotes.id, note.id), eq(jobNotes.version, note.version)))
        .returning({ id: jobNotes.id }),
    );
    if (!updated) continue;
    await recordEvent(tx, ctx, {
      entityType: "note",
      entityId: note.id,
      jobId: after.id,
      eventType: "note.archived",
      action: "archived",
      previousValue: { kind: note.kind, body: note.body, archivedAt: null },
      newValue: { kind: note.kind, body: note.body, archivedAt: at },
      metadata: { noteId: note.id, editCount: note.editCount, reason, ...jobMeta(after) },
    });
    archivedNoteIds.push(note.id);
  }
  return { unsharedLinkIds, archivedNoteIds, jobEventId };
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/** Ids of the job's current links that are visible to the client (shared ∧ current). */
export async function clientVisibleLinkIds(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = Array.from(new Set(jobIds));
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: jobLinks.id, jobId: jobLinks.jobId })
    .from(jobLinks)
    .where(
      and(
        eq(jobLinks.organisationId, ctx.organisationId),
        inArray(jobLinks.jobId, ids),
        eq(jobLinks.sharedWithClient, true),
        isNull(jobLinks.supersededAt),
        isNull(jobLinks.removedAt),
      ),
    )
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
  for (const r of rows) out.set(r.jobId, [...(out.get(r.jobId) ?? []), r.id]);
  return out;
}

/** True when the actor may share this job or its links (UI hint). */
export function canShareJob(ctx: AuthContext, ref: JobPermissionRef): boolean {
  return can(ctx, "job.share_with_client", ref);
}
