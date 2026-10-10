/**
 * External job links (ARCHITECTURE.md §2.4 job_links, §3.2 link rows, §5
 * link.* events).
 *
 * Links form supersession chains: `replaceLink` inserts a NEW row
 * (`supersedes_link_id = old.id`) and fills the OLD row's fill-once
 * `superseded_at` + `superseded_by_link_id`; nothing is ever overwritten, so
 * a slot's history is the chain walked from its root. `updateLink` changes a
 * link's kind / label the same way (new row, same URL, event `link.updated`):
 * the jl_fill_once trigger keeps link content immutable, so a re-filed link
 * keeps its full history. `removeLink` fills `removed_at/by/reason` once.
 * Current = not superseded and not removed; a slot's kind is its current
 * (latest) row's kind.
 *
 * URLs: http/https only, no embedded credentials; `provider` is derived from
 * the hostname at write time (`deriveLinkProvider`).
 *
 * Also exports the read helpers the workflow engine uses for its "no
 * finished files" / "no delivery link" warnings (§4.3 step 5).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { first, one, type DbLike, type Tx } from "@/db/index";
import { jobLinks } from "@/db/schema";
import { LINK_KINDS, LINK_KIND_META, type LinkKind, type StatusCategory } from "@/lib/constants";
import type { AuthContext, JobLink, JobPermissionRef, LinkSlot, LinkView } from "@/lib/types";
import { AddLinkInput, RemoveLinkInput, ReplaceLinkInput, UpdateLinkInput, deriveLinkProvider } from "@/lib/validation/links";
import { assertCan } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ConflictError, ValidationError } from "@/server/errors";
import { jobMeta, loadJobWithRef, loadUserRefMap, unknownUserRef } from "./_collab";
import { loadLinkInOrg, parseInput } from "./_shared";

export { deriveLinkProvider } from "@/lib/validation/links";

function isCurrent(link: Pick<JobLink, "supersededAt" | "removedAt">): boolean {
  return link.supersededAt === null && link.removedAt === null;
}

async function assertCurrent(tx: Tx, ctx: AuthContext, link: JobLink): Promise<void> {
  if (!isCurrent(link)) {
    throw new ConflictError(
      link.removedAt ? "This link was removed. Reload and try again." : "This link was already replaced. Reload and try again.",
      await loadLinkInOrg(tx, ctx, link.id),
    );
  }
}

async function setActivityEventId(tx: Tx, linkId: string, eventId: string): Promise<void> {
  await tx.update(jobLinks).set({ activityEventId: eventId }).where(and(eq(jobLinks.id, linkId), isNull(jobLinks.activityEventId)));
}

/** Fills the old row's fill-once supersession columns; 409 when it is no longer current. */
async function supersede(tx: Tx, ctx: AuthContext, oldId: string, at: string, newLinkId: string): Promise<JobLink> {
  const previous = await first(
    tx
      .update(jobLinks)
      .set({ supersededAt: at, supersededByLinkId: newLinkId })
      .where(and(eq(jobLinks.id, oldId), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
      .returning(),
  );
  if (!previous) throw new ConflictError("This link was changed by someone else. Reload and try again.", await loadLinkInOrg(tx, ctx, oldId));
  return previous;
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                          */
/* ------------------------------------------------------------------ */

/**
 * Adds a new link (a new slot). Permission `link.add`: owners/managers any
 * kind; photographers on own jobs (any kind); editors on assigned jobs,
 * kinds in EDITOR_LINK_KINDS.
 */
export async function addLink(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobLink> {
  const data = parseInput(AddLinkInput, input);
  const { job, ref } = await loadJobWithRef(tx, ctx, data.jobId);
  assertCan(ctx, "link.add", { job: ref, kind: data.kind });
  const addedByUserId = requireActor(ctx);

  const link = await one(
    tx
      .insert(jobLinks)
      .values({
        organisationId: ctx.organisationId,
        jobId: job.id,
        kind: data.kind,
        url: data.url,
        label: data.label ?? null,
        provider: deriveLinkProvider(data.url),
        addedByUserId,
        createdAt: ctx.now(),
      })
      .returning(),
    "link",
  );

  const eventId = await recordEvent(tx, ctx, {
    entityType: "link",
    entityId: link.id,
    jobId: job.id,
    eventType: "link.added",
    action: "created",
    previousValue: null,
    newValue: { linkId: link.id, kind: link.kind, url: link.url, label: link.label, provider: link.provider },
    metadata: { kind: link.kind, ...jobMeta(job) },
  });
  await setActivityEventId(tx, link.id, eventId);
  return { ...link, activityEventId: eventId };
}

/**
 * Replaces a current link: inserts the new row (`supersedes_link_id`) then
 * fills the old row's `superseded_at` / `superseded_by_link_id` (fill-once).
 * Permission `link.replace`: O/M any; photographer own job; editor assigned
 * job and a link they added. A stale (already replaced/removed) link → 409.
 */
export async function replaceLink(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ link: JobLink; previous: JobLink }> {
  const data = parseInput(ReplaceLinkInput, input);
  const old = await loadLinkInOrg(tx, ctx, data.linkId);
  const { job, ref } = await loadJobWithRef(tx, ctx, old.jobId);
  assertCan(ctx, "link.replace", { job: ref, kind: old.kind, addedByUserId: old.addedByUserId });
  await assertCurrent(tx, ctx, old);
  const addedByUserId = requireActor(ctx);

  const at = ctx.now();
  const label = data.label === undefined ? old.label : data.label;
  const link = await one(
    tx
      .insert(jobLinks)
      .values({
        organisationId: ctx.organisationId,
        jobId: job.id,
        kind: old.kind,
        url: data.url,
        label,
        provider: deriveLinkProvider(data.url),
        addedByUserId,
        createdAt: at,
        supersedesLinkId: old.id,
      })
      .returning(),
    "link",
  );

  const previous = await supersede(tx, ctx, old.id, at, link.id);

  const eventId = await recordEvent(tx, ctx, {
    entityType: "link",
    entityId: link.id,
    jobId: job.id,
    eventType: "link.replaced",
    action: "superseded",
    previousValue: { linkId: old.id, url: old.url, label: old.label, provider: old.provider },
    newValue: { linkId: link.id, url: link.url, label: link.label, provider: link.provider },
    metadata: { kind: link.kind, supersedesLinkId: old.id, ...jobMeta(job) },
  });
  await setActivityEventId(tx, link.id, eventId);
  return { link: { ...link, activityEventId: eventId }, previous };
}

/**
 * Changes a current link's kind and/or label (`PATCH /api/links/:id`). Same
 * URL; implemented as a supersession (new row `supersedes_link_id = old.id`,
 * old row's fill-once `superseded_*`) because link rows are immutable
 * (jl_fill_once). Permission `link.replace` on the old row, plus — when the
 * kind changes — `link.add` for the NEW kind (editors: EDITOR_LINK_KINDS
 * only). Stale link → 409. Event `link.updated` with before/after `{kind,label}`.
 */
export async function updateLink(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobLink> {
  const data = parseInput(UpdateLinkInput, input);
  const old = await loadLinkInOrg(tx, ctx, data.linkId);
  const { job, ref } = await loadJobWithRef(tx, ctx, old.jobId);
  assertCan(ctx, "link.replace", { job: ref, kind: old.kind, addedByUserId: old.addedByUserId });
  const kind = data.kind ?? old.kind;
  if (kind !== old.kind) assertCan(ctx, "link.add", { job: ref, kind });
  await assertCurrent(tx, ctx, old);
  const label = data.label === undefined ? old.label : data.label;
  if (kind === old.kind && label === old.label) return old;
  const addedByUserId = requireActor(ctx);

  const at = ctx.now();
  const link = await one(
    tx
      .insert(jobLinks)
      .values({
        organisationId: ctx.organisationId,
        jobId: job.id,
        kind,
        url: old.url,
        label,
        provider: old.provider ?? deriveLinkProvider(old.url),
        addedByUserId,
        createdAt: at,
        supersedesLinkId: old.id,
      })
      .returning(),
    "link",
  );
  await supersede(tx, ctx, old.id, at, link.id);

  const eventId = await recordEvent(tx, ctx, {
    entityType: "link",
    entityId: link.id,
    jobId: job.id,
    eventType: "link.updated",
    action: "updated",
    previousValue: { linkId: old.id, kind: old.kind, label: old.label },
    newValue: { linkId: link.id, kind: link.kind, label: link.label },
    metadata: { kind: link.kind, previousKind: old.kind, supersedesLinkId: old.id, url: link.url, ...jobMeta(job) },
  });
  await setActivityEventId(tx, link.id, eventId);
  return { ...link, activityEventId: eventId };
}

/** Removes a current link without replacement (fill-once `removed_*`). Permission `link.remove`. */
export async function removeLink(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobLink> {
  const data = parseInput(RemoveLinkInput, input);
  const old = await loadLinkInOrg(tx, ctx, data.linkId);
  const { job, ref } = await loadJobWithRef(tx, ctx, old.jobId);
  assertCan(ctx, "link.remove", { job: ref, kind: old.kind, addedByUserId: old.addedByUserId });
  await assertCurrent(tx, ctx, old);

  const removed = await first(
    tx
      .update(jobLinks)
      .set({ removedAt: ctx.now(), removedByUserId: ctx.userId, removeReason: data.reason ?? null })
      .where(and(eq(jobLinks.id, old.id), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
      .returning(),
  );
  if (!removed) throw new ConflictError("This link was changed by someone else. Reload and try again.", await loadLinkInOrg(tx, ctx, old.id));

  await recordEvent(tx, ctx, {
    entityType: "link",
    entityId: old.id,
    jobId: job.id,
    eventType: "link.removed",
    action: "removed",
    previousValue: { linkId: old.id, kind: old.kind, url: old.url, label: old.label },
    newValue: null,
    metadata: { kind: old.kind, reason: data.reason ?? null, ...jobMeta(job) },
  });
  return removed;
}

function requireActor(ctx: AuthContext): string {
  if (!ctx.userId) throw new ValidationError("Links must be added by a person");
  return ctx.userId;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

async function loadVisibleJob(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobPermissionRef> {
  const { ref } = await loadJobWithRef(db, ctx, jobId);
  assertCan(ctx, "job.view", ref);
  return ref;
}

async function allLinks(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobLink[]> {
  return db
    .select()
    .from(jobLinks)
    .where(and(eq(jobLinks.jobId, jobId), eq(jobLinks.organisationId, ctx.organisationId)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
}

async function toViews(db: DbLike, ctx: AuthContext, rows: readonly JobLink[]): Promise<Map<string, LinkView>> {
  const people = await loadUserRefMap(db, ctx, rows.flatMap((l) => [l.addedByUserId, l.removedByUserId]));
  const person = (id: string) => people.get(id) ?? unknownUserRef(id);
  return new Map(
    rows.map((l) => [
      l.id,
      {
        id: l.id,
        kind: l.kind,
        url: l.url,
        label: l.label,
        provider: l.provider,
        addedBy: person(l.addedByUserId),
        createdAt: l.createdAt,
        supersedesLinkId: l.supersedesLinkId,
        supersededAt: l.supersededAt,
        supersededByLinkId: l.supersededByLinkId,
        removedAt: l.removedAt,
        removedBy: l.removedByUserId ? person(l.removedByUserId) : null,
        removeReason: l.removeReason,
        isCurrent: isCurrent(l),
      },
    ]),
  );
}

const KIND_ORDER = new Map<LinkKind, number>(LINK_KINDS.map((k, i) => [k, i]));

/**
 * Pure: groups link rows into slots (one per supersession chain), ordered by
 * kind (LINK_KINDS order) then chain start. `history` is oldest → newest and
 * includes the current row. Without `withHistory`, only slots that still
 * have a current link are returned, each with `history = [current]`.
 */
export function buildLinkSlots(views: ReadonlyMap<string, LinkView>, withHistory: boolean): LinkSlot[] {
  const all = Array.from(views.values());
  const roots = all.filter((v) => !v.supersedesLinkId || !views.has(v.supersedesLinkId));
  const slots: LinkSlot[] = [];
  for (const root of roots) {
    const chain: LinkView[] = [root];
    const seen = new Set<string>([root.id]);
    let cursor: LinkView | undefined = root;
    while (cursor?.supersededByLinkId) {
      const next = views.get(cursor.supersededByLinkId);
      if (!next || seen.has(next.id)) break;
      chain.push(next);
      seen.add(next.id);
      cursor = next;
    }
    const last = chain[chain.length - 1];
    const current = last.isCurrent ? last : null;
    if (!withHistory && !current) continue;
    // The slot is filed under its latest row's kind (`updateLink` may re-file it).
    slots.push({ kind: last.kind, current, history: withHistory ? chain : current ? [current] : [] });
  }
  return slots.sort(
    (a, b) =>
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      (a.history[0]?.createdAt ?? "").localeCompare(b.history[0]?.createdAt ?? ""),
  );
}

/** The job's link slots (Links tab). Permission: `job.view`. `history: true` includes replaced/removed chains. */
export async function listLinks(db: DbLike, ctx: AuthContext, jobId: string, opts: { history?: boolean } = {}): Promise<LinkSlot[]> {
  await loadVisibleJob(db, ctx, jobId);
  const rows = await allLinks(db, ctx, jobId);
  return buildLinkSlots(await toViews(db, ctx, rows), opts.history ?? false);
}

/** Current finished-work links (finished files, gallery, client delivery) — the Overview "Finished Work" panel. */
export async function finishedWorkLinks(db: DbLike, ctx: AuthContext, jobId: string): Promise<LinkView[]> {
  await loadVisibleJob(db, ctx, jobId);
  const finishedKinds = LINK_KINDS.filter((k) => LINK_KIND_META[k].finishedWork);
  const rows = (await currentLinksOfKinds(db, jobId, finishedKinds)).filter((l) => l.organisationId === ctx.organisationId);
  const views = await toViews(db, ctx, rows);
  return rows
    .map((l) => views.get(l.id))
    .filter((v): v is LinkView => v !== undefined)
    .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) || a.createdAt.localeCompare(b.createdAt));
}

/* ------------------------------------------------------------------ */
/*  Engine helpers (no permission check: callers already loaded the job in-org) */
/* ------------------------------------------------------------------ */

/** Current link rows of the given kinds on a job, oldest first. */
export async function currentLinksOfKinds(db: DbLike, jobId: string, kinds: LinkKind | readonly LinkKind[]): Promise<JobLink[]> {
  const list = typeof kinds === "string" ? [kinds] : [...kinds];
  if (list.length === 0) return [];
  return db
    .select()
    .from(jobLinks)
    .where(and(eq(jobLinks.jobId, jobId), inArray(jobLinks.kind, list), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
}

/** True when the job has at least one current link of any of `kinds`. */
export async function hasCurrentLinkOfKind(db: DbLike, jobId: string, kinds: LinkKind | readonly LinkKind[]): Promise<boolean> {
  return (await currentLinksOfKinds(db, jobId, kinds)).length > 0;
}

export interface LinkWarning {
  code: "missing_finished_work" | "missing_delivery_link";
  message: string;
  /** Kinds any one of which would satisfy the check. */
  kinds: LinkKind[];
}

/** Kinds that satisfy the soft link checks per target category (§4.3 step 5). */
export const TRANSITION_LINK_EXPECTATIONS: Partial<Record<StatusCategory, LinkWarning>> = {
  submitted: {
    code: "missing_finished_work",
    kinds: ["finished_files", "editing_workspace"],
    message: "No finished files or editing workspace link has been added yet",
  },
  resubmitted: {
    code: "missing_finished_work",
    kinds: ["finished_files", "editing_workspace"],
    message: "No finished files or editing workspace link has been added yet",
  },
  delivered: {
    code: "missing_delivery_link",
    kinds: ["client_delivery", "gallery"],
    message: "No client delivery or gallery link has been added yet",
  },
};

/**
 * Soft warnings (never blocking) for moving a job into `toCategory`:
 * submitted/resubmitted without a current finished_files/editing_workspace
 * link, delivered without a current client_delivery/gallery link.
 */
export async function linkWarningsForTransition(db: DbLike, jobId: string, toCategory: StatusCategory): Promise<LinkWarning[]> {
  const expectation = TRANSITION_LINK_EXPECTATIONS[toCategory];
  if (!expectation) return [];
  if (await hasCurrentLinkOfKind(db, jobId, expectation.kinds)) return [];

  return [{ code: expectation.code, message: expectation.message, kinds: [...expectation.kinds] }];
}
