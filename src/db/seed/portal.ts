/**
 * Roles v2 demo story (docs/ROLES.md §13): client portal access, sharing,
 * delivery with client-visible links, delivery notes, a client feedback
 * thread, and jobs created by editors.
 *
 * Jobs and their workflow steps go through the real services. Sharing,
 * portal switches, client users and client feedback are written with direct,
 * trigger-safe updates plus their audit event in the SAME transaction,
 * because their dedicated services do not exist yet:
 *   TODO(roles-v2, package D — services/clients.ts, projects.ts): setClientPortal, shareProject →
 *     replace setSeedClientPortal / shareProjectTx. (Client users already go through
 *     `inviteUser({ role: "client" })` in inviteSeedClientUser.)
 *   TODO(roles-v2, package B — services/jobs.ts, workflow.ts): shareJob, the delivery step of
 *     applyMove (`delivery: { shareJob, shareLinkIds }`), createJob({ editorId: me, newProject })
 *     and claimJob → replace shareJobTx, the post-deliver sharing, the inline project insert and
 *     the direct assignEditorToJob calls.
 *   TODO(roles-v2, package C — services/links.ts, comments.ts): shareLink and client_feedback
 *     posting from the portal → replace shareLinkTx / postSeedClientFeedback.
 */
import { and, eq } from "drizzle-orm";
import { first, one } from "@/db/index";
import { clients, jobComments, jobs, jobLinks, projects, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { addCivilDays, civilDate } from "@/lib/dates";
import type { SharingReason } from "@/lib/constants";
import type { AuthContext, Job } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { createJob } from "@/server/services/jobs";
import { inviteUser } from "@/server/services/users";
import { assignEditor, assignEditorToJob } from "@/server/services/assignments";
import { approveJob, cancelJob, completeJob, deliverJob, startJob, submitJob } from "@/server/services/workflow";
import { addLink } from "@/server/services/links";
import { addNote } from "@/server/services/notes";
import { addComment } from "@/server/services/comments";
import { adminsOf, notify } from "@/server/services/notifications";
import type { Tx } from "@/server/services/_shared";
import { DAY, HOUR, MINUTE, type SeedRuntime } from "./runtime";

const TZ = "Australia/Sydney";

/* ------------------------------------------------------------------ */
/*  Sharing / portal primitives (direct writes + audit, one tx each)   */
/* ------------------------------------------------------------------ */

/** Portal + feedback switches of a client (event client.portal_updated). */
export async function setSeedClientPortal(
  rt: SeedRuntime,
  actorId: string,
  clientId: string,
  value: { portalEnabled: boolean; feedbackEnabled: boolean },
): Promise<void> {
  await rt.act(actorId, async (tx, ctx) => {
    const row = await one(tx.select().from(clients).where(eq(clients.id, clientId)), "client");
    await tx
      .update(clients)
      .set({ ...value, version: row.version + 1, updatedAt: ctx.now() })
      .where(eq(clients.id, clientId));
    await recordEvent(tx, ctx, {
      entityType: "client",
      entityId: clientId,
      eventType: "client.portal_updated",
      action: "updated",
      previousValue: { portalEnabled: row.portalEnabled, feedbackEnabled: row.feedbackEnabled },
      newValue: value,
      metadata: { clientName: row.name },
    });
  });
}

/** A client portal user (role client, linked to `clientId`); event user.created. */
export async function inviteSeedClientUser(
  rt: SeedRuntime,
  orgSlug: string,
  actorId: string,
  clientId: string,
  def: { key: string; email: string; name: string; avatarColour: string },
  passwordHash: string,
): Promise<string> {
  // Through the real service (portal must already be on for the client: §6.1).
  const result = await rt.act(actorId, (tx, ctx) =>
    inviteUser(tx, ctx, { email: def.email, name: def.name, role: "client", clientId, avatarColour: def.avatarColour }, { tempPassword: "", passwordHash }),
  );
  rt.registerUser(orgSlug, def.key, result.user.id, result.user.organisationId);
  return result.user.id;
}

async function clientUserIds(tx: Tx, organisationId: string, clientId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organisationId, organisationId), eq(users.clientId, clientId), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/** Shares a project (every current and future job) with its client; event project.client_sharing_changed. */
export async function shareProjectTx(tx: Tx, ctx: AuthContext, projectId: string): Promise<void> {
  const project = await one(tx.select().from(projects).where(eq(projects.id, projectId)), "project");
  if (project.sharedWithClient) return;
  await tx
    .update(projects)
    .set({ sharedWithClient: true, version: project.version + 1, updatedAt: ctx.now() })
    .where(eq(projects.id, projectId));
  const jobCount = (await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.projectId, projectId))).length;
  const eventId = await recordEvent(tx, ctx, {
    entityType: "project",
    entityId: projectId,
    eventType: "project.client_sharing_changed",
    action: "updated",
    previousValue: { shared: false },
    newValue: { shared: true },
    metadata: { reason: "manual", projectName: project.name, jobCount },
  });
  await notify(tx, ctx, {
    userIds: await clientUserIds(tx, ctx.organisationId, project.clientId),
    type: "client_work_shared",
    title: jobCount === 1 ? `1 job at ${project.name} is now available` : `${jobCount} jobs at ${project.name} are now available`,
    activityEventId: eventId,
    linkPath: "/portal",
  });
}

/** Shares one job with its client; event job.client_sharing_changed (version++). */
export async function shareJobTx(tx: Tx, ctx: AuthContext, jobId: string, reason: SharingReason): Promise<string | null> {
  const job = await one(tx.select().from(jobs).where(eq(jobs.id, jobId)), "job");
  if (job.sharedWithClient) return null;
  await tx
    .update(jobs)
    .set({ sharedWithClient: true, version: job.version + 1, updatedAt: ctx.now() })
    .where(eq(jobs.id, jobId));
  return recordEvent(tx, ctx, {
    entityType: "job",
    entityId: jobId,
    jobId,
    eventType: "job.client_sharing_changed",
    action: "updated",
    previousValue: { shared: false },
    newValue: { shared: true },
    metadata: { reason, jobNumber: job.jobNumber, jobName: job.name },
  });
}

/** Shares one CURRENT link with the client; event link.client_sharing_changed. */
export async function shareLinkTx(tx: Tx, ctx: AuthContext, linkId: string, reason: SharingReason): Promise<void> {
  const link = await one(tx.select().from(jobLinks).where(eq(jobLinks.id, linkId)), "link");
  if (link.sharedWithClient) return;
  if (link.supersededAt || link.removedAt) throw new Error(`seed: link ${linkId} is not current`);
  await tx.update(jobLinks).set({ sharedWithClient: true }).where(eq(jobLinks.id, linkId));
  const job = await one(tx.select().from(jobs).where(eq(jobs.id, link.jobId)), "job");
  await recordEvent(tx, ctx, {
    entityType: "link",
    entityId: linkId,
    jobId: link.jobId,
    eventType: "link.client_sharing_changed",
    action: "updated",
    previousValue: { shared: false },
    newValue: { shared: true },
    metadata: { reason, kind: link.kind, jobNumber: job.jobNumber, jobName: job.name },
  });
}

/** client_work_delivered / client_work_shared to every active portal user of the job's client. */
async function notifyClientsOfJob(tx: Tx, ctx: AuthContext, job: Job, type: "client_work_delivered" | "client_work_shared", eventId: string | null): Promise<void> {
  await notify(tx, ctx, {
    userIds: await clientUserIds(tx, ctx.organisationId, job.clientId),
    type,
    title: type === "client_work_delivered" ? `Your work is ready: ${job.name}` : `${job.name} is now available`,
    jobId: job.id,
    activityEventId: eventId,
    linkPath: `/portal/jobs/${job.id}`,
  });
}

/**
 * A client's feedback comment (kind client_feedback, root or reply inside a client thread):
 * event comment.added (visibility all) and `client_feedback` to the job's photographer,
 * its creator (when a photographer) and every admin.
 */
export async function postSeedClientFeedback(rt: SeedRuntime, clientUserId: string, jobId: string, body: string, parentCommentId?: string): Promise<string> {
  return rt.act(clientUserId, async (tx, ctx) => {
    const job = await one(tx.select().from(jobs).where(eq(jobs.id, jobId)), "job");
    let rootCommentId: string | null = null;
    if (parentCommentId) {
      const parent = await one(tx.select().from(jobComments).where(eq(jobComments.id, parentCommentId)), "comment");
      rootCommentId = parent.rootCommentId ?? parent.id;
    }
    const id = newId();
    await tx.insert(jobComments).values({
      id,
      organisationId: ctx.organisationId,
      jobId,
      parentCommentId: parentCommentId ?? null,
      rootCommentId: rootCommentId ?? id,
      authorUserId: clientUserId,
      kind: "client_feedback",
      body,
      createdAt: ctx.now(),
    });
    const eventId = await recordEvent(tx, ctx, {
      entityType: "comment",
      entityId: id,
      jobId,
      eventType: "comment.added",
      action: "created",
      previousValue: null,
      newValue: { body, kind: "client_feedback", parentCommentId: parentCommentId ?? null, rootCommentId: rootCommentId ?? id, mentionUserIds: [] },
      metadata: { commentId: id, jobNumber: job.jobNumber, jobName: job.name },
      visibility: "all",
    });
    const author = await one(tx.select({ name: users.name }).from(users).where(eq(users.id, clientUserId)), "author");
    await notify(tx, ctx, {
      userIds: [job.photographerId, job.createdByRole === "photographer" ? job.createdByUserId : null, ...(await adminsOf(tx, ctx.organisationId))],
      type: "client_feedback",
      title: `${author.name} left feedback on ${job.jobNumber}`,
      body,
      jobId,
      activityEventId: eventId,
      linkPath: `/jobs/${jobId}#comment-${id}`,
    });
    return id;
  });
}

/* ------------------------------------------------------------------ */
/*  Story                                                              */
/* ------------------------------------------------------------------ */

export interface PortalStoryRefs {
  orgSlug: string;
  /** client name → id */
  clientIds: Record<string, string>;
  /** "Client / Project" → project id, resolved when the step runs (projects are created by the seeder). */
  projectId: (clientName: string, projectName: string) => string;
  jobTypes: Record<string, string>;
}

/** Job version read on the root db (call OUTSIDE act()). */
async function versionOf(rt: SeedRuntime, jobId: string): Promise<number> {
  return (await first(rt.db.select({ version: jobs.version }).from(jobs).where(eq(jobs.id, jobId))))?.version ?? 0;
}

async function jobRow(rt: SeedRuntime, jobId: string): Promise<Job> {
  const row = await first(rt.db.select().from(jobs).where(eq(jobs.id, jobId)));
  if (!row) throw new Error(`seed: job ${jobId} missing`);
  return row;
}

type Step = (tx: Tx, ctx: AuthContext, input: { jobId: string; expectedVersion: number }) => Promise<unknown>;

/**
 * Schedules the Harbourline / Campbell Parade portal story and the six
 * editor-created jobs on the runtime queue (they run in global time order with
 * the rest of the history). Harbourline Realty is excluded from the generic
 * job planner, so every Harbourline job is one of these scripted jobs.
 */
export function schedulePortalStory(rt: SeedRuntime, refs: PortalStoryRefs): void {
  const N = rt.nowMs;
  const u = (key: string) => rt.user(refs.orgSlug, key);
  const civil = (ms: number) => civilDate(new Date(ms), TZ) as string;
  const ids: Record<string, string> = {};
  const links: Record<string, string> = {};
  const comments: Record<string, string> = {};
  const harbourline = "Harbourline Realty";
  const ocean = () => refs.projectId(harbourline, "14 Ocean Street");
  const campbell = () => refs.projectId(harbourline, "7/22 Campbell Parade");

  const at = (ms: number, label: string, run: () => Promise<void>) => rt.schedule(ms, `portal ${label}`, run);
  const step = (ms: number, label: string, actor: string, key: string, fn: Step) =>
    at(ms, `${key} ${label}`, async () => {
      const jobId = ids[key];
      const expectedVersion = await versionOf(rt, jobId);
      await rt.act(u(actor), (tx, ctx) => fn(tx, ctx, { jobId, expectedVersion }));
    });
  const create = (
    ms: number,
    key: string,
    actor: string,
    input: { name: string; project: () => string; type: string; photographer: string; shootMs?: number; dueDays?: number; deliveryDays?: number },
  ) =>
    at(ms, `${key} create`, async () => {
      const shoot = civil(input.shootMs ?? ms);
      const result = await rt.act(u(actor), (tx, ctx) =>
        createJob(tx, ctx, {
          name: input.name,
          projectId: input.project(),
          jobTypeId: refs.jobTypes[input.type],
          photographerId: u(input.photographer),
          shootDate: shoot,
          dueDate: addCivilDays(shoot, input.dueDays ?? 1),
          ...(input.deliveryDays !== undefined ? { deliveryDueDate: addCivilDays(shoot, input.deliveryDays) } : {}),
        }),
      );
      ids[key] = result.job.id;
    });
  const link = (ms: number, key: string, actor: string, kind: string, url: string, label?: string) =>
    at(ms, `${key} link ${kind}`, async () => {
      const row = await rt.act(u(actor), (tx, ctx) => addLink(tx, ctx, { jobId: ids[key], kind, url, ...(label ? { label } : {}) }));
      links[`${key}:${kind}`] = row.id;
    });
  const assign = (ms: number, key: string, actor: string, editor: string) =>
    step(ms, "assign", actor, key, (tx, ctx, v) => assignEditor(tx, ctx, { ...v, userId: u(editor) }));
  /** Deliver as `actor`, then the delivery step (§7.3): optionally share the job, then share the given links. */
  const deliver = (ms: number, key: string, actor: string, opts: { shareJob: boolean; linkKinds: string[]; note?: string }) =>
    at(ms, `${key} deliver`, async () => {
      const jobId = ids[key];
      const expectedVersion = await versionOf(rt, jobId);
      await rt.act(u(actor), async (tx, ctx) => {
        await deliverJob(tx, ctx, { jobId, expectedVersion });
        if (opts.shareJob) await shareJobTx(tx, ctx, jobId, "delivered");
        for (const kind of opts.linkKinds) await shareLinkTx(tx, ctx, links[`${key}:${kind}`], "delivered");
        if (opts.note) await addNote(tx, ctx, { jobId, kind: "delivery", body: opts.note });
        const job = await one(tx.select().from(jobs).where(eq(jobs.id, jobId)), "job");
        await notifyClientsOfJob(tx, ctx, job, "client_work_delivered", null);
      });
    });

  /* ---------- 14 Ocean Street: shared at project level ---------- */
  at(N - 30 * DAY, "share 14 Ocean Street", async () => {
    await rt.act(u("owner"), (tx, ctx) => shareProjectTx(tx, ctx, ocean()));
  });

  // A — completed: the owner's own shoot, delivered with gallery + client delivery + a delivery note.
  {
    const t = N - 28 * DAY + 9 * HOUR;
    create(t, "A", "owner", { name: "14 Ocean Street · Listing photos", project: ocean, type: "Real Estate", photographer: "owner", deliveryDays: 3 });
    link(t + HOUR, "A", "owner", "raw_files", "https://www.dropbox.com/scl/fo/hl14ocean/raw");
    assign(t + 2 * HOUR, "A", "owner", "editor01");
    step(t + 3 * HOUR, "start", "editor01", "A", (tx, ctx, v) => startJob(tx, ctx, v));
    link(t + 7 * HOUR, "A", "editor01", "finished_files", "https://drive.google.com/drive/folders/hl14ocean-final");
    step(t + 7 * HOUR + 5 * MINUTE, "submit", "editor01", "A", (tx, ctx, v) => submitJob(tx, ctx, v));
    step(t + DAY, "approve", "owner", "A", (tx, ctx, v) => approveJob(tx, ctx, v));
    link(t + DAY + HOUR, "A", "owner", "gallery", "https://northlight.pixieset.com/14-ocean-street", "Online gallery");
    link(t + DAY + HOUR + 5 * MINUTE, "A", "owner", "client_delivery", "https://we.tl/t-hl14oceanfinal", "Full-resolution download");
    deliver(t + DAY + 2 * HOUR, "A", "owner", {
      shareJob: false,
      linkKinds: ["gallery", "client_delivery"],
      note: "Your listing photos are ready: 32 images, web and print sizes. The gallery link stays live for 90 days.",
    });
    step(t + 2 * DAY, "complete", "owner", "A", (tx, ctx, v) => completeJob(tx, ctx, v));
  }

  // B — delivered by photographer02 (team member who reviews her own shoots) + the client feedback thread.
  {
    const t = N - 12 * DAY + 8 * HOUR;
    create(t, "B", "photographer02", { name: "14 Ocean Street · Twilight hero shots", project: ocean, type: "Twilight", photographer: "photographer02", dueDays: 2, deliveryDays: 4 });
    link(t + HOUR, "B", "photographer02", "raw_files", "https://www.dropbox.com/scl/fo/hl14twilight/raw");
    assign(t + 2 * HOUR, "B", "photographer02", "editor02");
    step(t + 4 * HOUR, "start", "editor02", "B", (tx, ctx, v) => startJob(tx, ctx, v));
    link(t + DAY + 2 * HOUR, "B", "editor02", "finished_files", "https://drive.google.com/drive/folders/hl14twilight-final");
    step(t + DAY + 2 * HOUR + 5 * MINUTE, "submit", "editor02", "B", (tx, ctx, v) => submitJob(tx, ctx, v));
    step(t + 2 * DAY + HOUR, "approve", "photographer02", "B", (tx, ctx, v) => approveJob(tx, ctx, v));
    link(t + 2 * DAY + 2 * HOUR, "B", "photographer02", "gallery", "https://northlight.pixieset.com/14-ocean-street-twilight", "Twilight gallery");
    link(t + 2 * DAY + 2 * HOUR + 5 * MINUTE, "B", "photographer02", "client_delivery", "https://we.tl/t-hl14twilight", "Download");
    deliver(t + 2 * DAY + 3 * HOUR, "B", "photographer02", {
      shareJob: false,
      linkKinds: ["gallery", "client_delivery"],
      note: "Six twilight exteriors with sky and window glow balanced. Square crops are in the download for socials.",
    });
    // Internal-only collaboration on the same job (never reaches the portal).
    at(t + 3 * DAY, "B internal note", async () => {
      await rt.act(u("owner"), (tx, ctx) => addNote(tx, ctx, { jobId: ids.B, kind: "internal", body: "Harbourline is on 14-day terms. Bill the twilight set at the premium rate." }));
    });
    at(t + 3 * DAY + 10 * MINUTE, "B internal comment", async () => {
      await rt.act(u("owner"), (tx, ctx) => addComment(tx, ctx, { jobId: ids.B, body: "Nice work on these. Keep this grade as the Harbourline twilight look." }));
    });
    at(N - 2 * DAY + 10 * HOUR, "B feedback", async () => {
      comments.root = await postSeedClientFeedback(rt, u("client"), ids.B, "Love these! Could the hero shot be a touch warmer? The vendor wants it to feel like summer.");
    });
    at(N - DAY + 9 * HOUR, "B feedback reply", async () => {
      await rt.act(u("owner"), async (tx, ctx) => {
        const reply = await addComment(tx, ctx, {
          jobId: ids.B,
          kind: "client_feedback",
          parentCommentId: comments.root,
          body: "Thanks Sarah! We'll warm up the hero and re-share it by tomorrow afternoon.",
        });
        const job = await one(tx.select().from(jobs).where(eq(jobs.id, ids.B)), "job");
        await notify(tx, ctx, {
          userIds: await clientUserIds(tx, ctx.organisationId, job.clientId),
          type: "client_feedback_reply",
          title: `The studio replied on ${job.name}`,
          body: reply.comment.body,
          jobId: job.id,
          linkPath: `/portal/jobs/${job.id}`,
        });
      });
    });
    at(N - 6 * HOUR, "B feedback follow-up", async () => {
      await postSeedClientFeedback(rt, u("client"), ids.B, "Great, thank you. Could we also get a square crop of the hero for Instagram?", comments.root);
    });
  }

  // C — in editing, with an explicitly shared reference link (floor-plan PDF).
  {
    const t = N - 3 * DAY + 9 * HOUR;
    create(t, "C", "photographer02", { name: "14 Ocean Street · Floor plan", project: ocean, type: "Floor Plans", photographer: "photographer02", dueDays: 4 });
    link(t + HOUR, "C", "photographer02", "raw_files", "https://www.dropbox.com/scl/fo/hl14plan/raw");
    assign(t + 2 * HOUR, "C", "photographer02", "editor01");
    step(t + 3 * HOUR, "start", "editor01", "C", (tx, ctx, v) => startJob(tx, ctx, v));
    link(t + DAY, "C", "photographer02", "reference", "https://www.dropbox.com/scl/fi/hl14plan/14-ocean-street-floor-plan.pdf", "Floor plan (PDF)");
    at(t + DAY + 5 * MINUTE, "C share reference", async () => {
      await rt.act(u("photographer02"), (tx, ctx) => shareLinkTx(tx, ctx, links["C:reference"], "manual"));
    });
  }

  // D — cancelled within the last 30 days (the portal shows it as Cancelled).
  {
    const t = N - 20 * DAY + 10 * HOUR;
    create(t, "D", "owner", { name: "14 Ocean Street · Drone stills", project: ocean, type: "Drone", photographer: "photographer02" });
    step(N - 15 * DAY, "cancel", "owner", "D", (tx, ctx, v) => cancelJob(tx, ctx, { ...v, reason: "Drone permit for the beachfront was refused" }));
  }

  /* ---------- 7/22 Campbell Parade: project NOT shared; two jobs shared individually ---------- */

  // E — delivered with only finished files, shared through the Deliver dialog.
  {
    const t = N - 9 * DAY + 9 * HOUR;
    create(t, "E", "owner", { name: "7/22 Campbell Parade · Listing photos", project: campbell, type: "Real Estate", photographer: "owner" });
    link(t + HOUR, "E", "owner", "raw_files", "https://www.dropbox.com/scl/fo/hl722/raw");
    assign(t + 2 * HOUR, "E", "owner", "editor01");
    step(t + 3 * HOUR, "start", "editor01", "E", (tx, ctx, v) => startJob(tx, ctx, v));
    link(t + 8 * HOUR, "E", "editor01", "finished_files", "https://drive.google.com/drive/folders/hl722-final", "Final images");
    step(t + 8 * HOUR + 5 * MINUTE, "submit", "editor01", "E", (tx, ctx, v) => submitJob(tx, ctx, v));
    step(t + DAY, "approve", "owner", "E", (tx, ctx, v) => approveJob(tx, ctx, v));
    deliver(t + DAY + HOUR, "E", "owner", { shareJob: true, linkKinds: ["finished_files"] });
  }

  // F — booked with a future shoot date, shared individually.
  {
    const t = N - DAY + 9 * HOUR;
    create(t, "F", "owner", {
      name: "7/22 Campbell Parade · Auction campaign",
      project: campbell,
      type: "Real Estate",
      photographer: "photographer02",
      shootMs: N + 5 * DAY,
      deliveryDays: 2,
    });
    at(t + HOUR, "F share", async () => {
      await rt.act(u("owner"), async (tx, ctx) => {
        const eventId = await shareJobTx(tx, ctx, ids.F, "manual");
        const job = await one(tx.select().from(jobs).where(eq(jobs.id, ids.F)), "job");
        await notifyClientsOfJob(tx, ctx, job, "client_work_shared", eventId);
      });
    });
  }

  /* ---------- Editor-created jobs (§4.3): editor01 ×4, editor04 ×2 ---------- */
  const paddington = () => refs.projectId("Paddington & Co Real Estate", "27 Glenmore Road");
  const arden = () => refs.projectId("Coastal Key Property", "38 Arden Street");
  /** Editor creates the job and (optionally) assigns themself in the same transaction. */
  const editorCreate = (ms: number, key: string, editor: string, input: { name: string; project: () => string | Promise<string>; type: string; photographer: string; selfAssign: boolean }) =>
    at(ms, `${key} editor create`, async () => {
      const projectId = await input.project();
      const shoot = civil(ms);
      ids[key] = await rt.act(u(editor), async (tx, ctx) => {
        const created = await createJob(tx, ctx, {
          name: input.name,
          projectId,
          jobTypeId: refs.jobTypes[input.type],
          photographerId: u(input.photographer),
          shootDate: shoot,
          dueDate: addCivilDays(shoot, 2),
        });
        if (input.selfAssign) await assignEditorToJob(tx, ctx, created.job, ctx.userId, { reason: "Self-assigned at creation" });
        return created.job.id;
      });
    });
  const editorFinish = (t: number, key: string, editor: string, complete: boolean) => {
    step(t, "start", editor, key, (tx, ctx, v) => startJob(tx, ctx, v));
    link(t + 4 * HOUR, key, editor, "finished_files", `https://drive.google.com/drive/folders/${key.toLowerCase()}-editor-final`);
    if (!complete) return;
    step(t + 4 * HOUR + 5 * MINUTE, "submit", editor, key, (tx, ctx, v) => submitJob(tx, ctx, v));
    step(t + DAY, "approve", "owner", key, (tx, ctx, v) => approveJob(tx, ctx, v));
    step(t + DAY + HOUR, "complete", "owner", key, (tx, ctx, v) => completeJob(tx, ctx, v));
  };
  {
    const t1 = N - 18 * DAY + 15 * HOUR;
    editorCreate(t1, "G1", "editor01", { name: "27 Glenmore Road · Listing photos", project: paddington, type: "Real Estate", photographer: "owner", selfAssign: true });
    editorFinish(t1 + HOUR, "G1", "editor01", true);

    const t2 = N - 14 * DAY + 16 * HOUR;
    editorCreate(t2, "G2", "editor01", { name: "27 Glenmore Road · Dusk hero shots", project: paddington, type: "Twilight", photographer: "owner", selfAssign: true });
    editorFinish(t2 + HOUR, "G2", "editor01", true);

    // G3 — inline-created project under an existing client, in progress, with an open question for the owner.
    const t3 = N - 2 * DAY + 14 * HOUR;
    editorCreate(t3, "G3", "editor01", {
      name: "16 Hopetoun Avenue · Listing photos",
      project: () => createInlineProject(rt, u("editor01"), refs.clientIds["Eastbound Property Group"], "16 Hopetoun Avenue", "Vaucluse NSW 2030"),
      type: "Real Estate",
      photographer: "owner",
      selfAssign: true,
    });
    step(t3 + HOUR, "start", "editor01", "G3", (tx, ctx, v) => startJob(tx, ctx, v));
    at(t3 + 3 * HOUR, "G3 question", async () => {
      await rt.act(u("editor01"), (tx, ctx) =>
        addComment(tx, ctx, { jobId: ids.G3, kind: "question", body: "Quick question: do you want the pool shots with the cover off or on? The vendor sent both." }),
      );
    });

    const t4 = N - 20 * HOUR;
    editorCreate(t4, "G4", "editor01", { name: "27 Glenmore Road · Floor plan", project: paddington, type: "Floor Plans", photographer: "owner", selfAssign: true });

    const t5 = N - 4 * DAY + 11 * HOUR;
    editorCreate(t5, "G5", "editor04", { name: "38 Arden Street · Drone stills", project: arden, type: "Drone", photographer: "photographer02", selfAssign: false });

    const t6 = N - 6 * DAY + 10 * HOUR;
    editorCreate(t6, "G6", "editor04", { name: "38 Arden Street · Listing photos", project: arden, type: "Real Estate", photographer: "photographer02", selfAssign: false });
    // Claimed later by its creator (draft window still open: never started, no editor removed).
    at(t6 + DAY, "G6 claim", async () => {
      const job = await jobRow(rt, ids.G6);
      await rt.act(u("editor04"), (tx, ctx) => assignEditorToJob(tx, ctx, job, ctx.userId, { reason: "Claimed by the editor who created it" }));
    });
  }
}

/** Editor's inline "New project" under an existing client (§4.3); event project.created by the editor. */
async function createInlineProject(rt: SeedRuntime, editorId: string, clientId: string, name: string, address: string): Promise<string> {
  return rt.act(editorId, async (tx, ctx) => {
    const now = ctx.now();
    const row = await one(
      tx
        .insert(projects)
        .values({ organisationId: ctx.organisationId, clientId, name, address, createdByUserId: editorId, createdAt: now, updatedAt: now })
        .returning(),
      "project",
    );
    await recordEvent(tx, ctx, {
      entityType: "project",
      entityId: row.id,
      eventType: "project.created",
      action: "created",
      previousValue: null,
      newValue: { name, clientId, address },
      metadata: { projectName: name, inlineFromJobCreate: true },
    });
    return row.id;
  });
}

/* ------------------------------------------------------------------ */
/*  Other Studio: its own portal client with one shared delivered job  */
/* ------------------------------------------------------------------ */

export async function seedOtherStudioPortal(
  rt: SeedRuntime,
  opts: { orgSlug: string; ownerId: string; editorId: string; clientId: string; jobTypeId: string; passwordHash: string; startMs: number },
): Promise<void> {
  const { ownerId, editorId } = opts;
  let t = opts.startMs;
  const set = (ms: number) => {
    t = ms;
    rt.setTime(t);
  };
  set(t);
  await setSeedClientPortal(rt, ownerId, opts.clientId, { portalEnabled: true, feedbackEnabled: true });
  await inviteSeedClientUser(rt, opts.orgSlug, ownerId, opts.clientId, { key: "client", email: "client@other.test", name: "Jordan Pike", avatarColour: "#0ea5e9" }, opts.passwordHash);
  set(t + 10 * MINUTE);
  const project = await rt.act(ownerId, async (tx, ctx) => {
    const now = ctx.now();
    const row = await one(
      tx
        .insert(projects)
        .values({ organisationId: ctx.organisationId, clientId: opts.clientId, name: "1 Harbour View", address: "1 Harbour View, Mosman NSW 2088", createdByUserId: ownerId, createdAt: now, updatedAt: now })
        .returning(),
      "project",
    );
    await recordEvent(tx, ctx, {
      entityType: "project",
      entityId: row.id,
      eventType: "project.created",
      action: "created",
      previousValue: null,
      newValue: { name: row.name, clientId: opts.clientId, address: row.address },
      metadata: { projectName: row.name },
    });
    return row.id;
  });
  set(t + 20 * MINUTE);
  const shoot = civilDate(new Date(t), TZ) as string;
  const jobId = (
    await rt.act(ownerId, (tx, ctx) =>
      createJob(tx, ctx, { name: "1 Harbour View · Listing photos", projectId: project, jobTypeId: opts.jobTypeId, photographerId: ownerId, shootDate: shoot, dueDate: addCivilDays(shoot, 1) }),
    )
  ).job.id;
  const run = async (actor: string, ms: number, fn: Step) => {
    set(ms);
    const expectedVersion = await versionOf(rt, jobId);
    await rt.act(actor, (tx, ctx) => fn(tx, ctx, { jobId, expectedVersion }));
  };
  await run(ownerId, t + HOUR, (tx, ctx, v) => assignEditor(tx, ctx, { ...v, userId: editorId }));
  await run(editorId, t + 2 * HOUR, (tx, ctx, v) => startJob(tx, ctx, v));
  set(t + 5 * HOUR);
  const finished = await rt.act(editorId, (tx, ctx) => addLink(tx, ctx, { jobId, kind: "finished_files", url: "https://drive.google.com/drive/folders/otherstudio-harbourview" }));
  await run(editorId, t + 5 * HOUR + 5 * MINUTE, (tx, ctx, v) => submitJob(tx, ctx, v));
  await run(ownerId, t + DAY, (tx, ctx, v) => approveJob(tx, ctx, v));
  await run(ownerId, t + DAY + HOUR, async (tx, ctx, v) => {
    await deliverJob(tx, ctx, v);
    const eventId = await shareJobTx(tx, ctx, jobId, "delivered");
    await shareLinkTx(tx, ctx, finished.id, "delivered");
    const job = await one(tx.select().from(jobs).where(eq(jobs.id, jobId)), "job");
    await notifyClientsOfJob(tx, ctx, job, "client_work_delivered", eventId);
  });
}
