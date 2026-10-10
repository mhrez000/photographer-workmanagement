/**
 * Client portal pure helpers (docs/ROLES.md §7.4).
 *
 * - `clientMilestone()` maps a job's status category + shoot date to the four
 *   client milestones (Booked > Shot > Editing > Delivered). Shoot dates
 *   compare as CALENDAR DAYS in the organisation timezone: `shoot_date` is a
 *   UTC instant, so 23:30 UTC can already be "tomorrow" in Sydney.
 * - `milestoneSteps()` turns a projected job into the stepper rows.
 *
 * No DB access, no React: shared by src/server/queries/portal.ts, the portal
 * pages and the staff "What the client sees" preview.
 */
import {
  CLIENT_MILESTONE_CANCELLED_LABEL,
  CLIENT_MILESTONE_CATEGORIES,
  CLIENT_MILESTONE_LABELS,
  CLIENT_MILESTONE_UPDATING_LABEL,
  CLIENT_MILESTONES,
  type ClientMilestone,
  type StatusCategory,
} from "@/lib/constants";
import { civilDate, DEFAULT_TIMEZONE, toDate, todayCivil, type DateInput } from "@/lib/dates";
import type { PortalJob, PortalMilestone } from "@/lib/types";

export interface ClientMilestoneInput {
  category: StatusCategory;
  shootDate: string | null;
  /** The job has a transition into delivered or completed (ever). */
  everDelivered: boolean;
  /** Latest transition into delivered/completed (for the "Delivered 18 Oct" detail). */
  deliveredAt?: string | null;
  cancelledAt?: string | null;
}

export interface ClientMilestoneResult {
  /** null = cancelled. */
  milestone: ClientMilestone | null;
  label: string;
  detail: string | null;
  /** Reopened after delivery: the delivered files stay available. */
  updating: boolean;
  cancelled: boolean;
}

/** "12 Oct" in the organisation timezone. */
export function portalDay(value: DateInput, timeZone: string = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone }).format(d);
}

/** "12 Oct 2026" in the organisation timezone. */
export function portalDate(value: DateInput, timeZone: string = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone }).format(d);
}

/**
 * Milestone mapping, first match wins (§7.4):
 *   cancelled → null "Cancelled"; delivered/completed → Delivered;
 *   ever delivered (reopened) → Delivered + updating; pre-editing → Booked/Shot
 *   by the shoot's calendar day; editing categories → Editing.
 */
export function clientMilestone(input: ClientMilestoneInput, now: DateInput, timeZone: string = DEFAULT_TIMEZONE): ClientMilestoneResult {
  const { category } = input;
  if (category === "cancelled") {
    const day = portalDay(input.cancelledAt, timeZone);
    return {
      milestone: null,
      label: CLIENT_MILESTONE_CANCELLED_LABEL,
      detail: day ? `Cancelled by the studio on ${day}` : "Cancelled by the studio",
      updating: false,
      cancelled: true,
    };
  }
  if (CLIENT_MILESTONE_CATEGORIES.delivered.includes(category)) {
    const day = portalDay(input.deliveredAt, timeZone);
    return { milestone: "delivered", label: CLIENT_MILESTONE_LABELS.delivered, detail: day ? `Delivered ${day}` : null, updating: false, cancelled: false };
  }
  if (input.everDelivered) {
    return {
      milestone: "delivered",
      label: CLIENT_MILESTONE_UPDATING_LABEL,
      detail: "Your delivered files stay available",
      updating: true,
      cancelled: false,
    };
  }
  if (CLIENT_MILESTONE_CATEGORIES.preEditing.includes(category)) {
    const shootDay = civilDate(input.shootDate, timeZone);
    if (shootDay === null) return booked(null);
    const today = todayCivil(timeZone, toDate(now) ?? new Date());
    if (shootDay > today) return booked(`Shoot scheduled for ${portalDay(input.shootDate, timeZone)}`);
    if (shootDay === today) return booked("Shoot today");
    return { milestone: "shot", label: CLIENT_MILESTONE_LABELS.shot, detail: null, updating: false, cancelled: false };
  }
  // in_progress, submitted, review, revision, resubmitted, approved (and any future editing-side category).
  return { milestone: "editing", label: CLIENT_MILESTONE_LABELS.editing, detail: null, updating: false, cancelled: false };
}

function booked(detail: string | null): ClientMilestoneResult {
  return { milestone: "booked", label: CLIENT_MILESTONE_LABELS.booked, detail, updating: false, cancelled: false };
}

/**
 * The four stepper rows for a projected job. Steps before the current one are
 * done; the current one is "current" (or done when the job is delivered and not
 * being updated). Cancelled jobs have no stepper (empty array).
 */
export function milestoneSteps(job: Pick<PortalJob, "milestone" | "updating" | "shootDate" | "deliveredAt" | "deliveryDueDate">): PortalMilestone[] {
  if (job.milestone === null) return [];
  const currentIndex = CLIENT_MILESTONES.indexOf(job.milestone);
  const finished = job.milestone === "delivered" && !job.updating;
  return CLIENT_MILESTONES.map((key, index): PortalMilestone => {
    const state: PortalMilestone["state"] =
      index < currentIndex || (finished && index === currentIndex) ? "done" : index === currentIndex ? "current" : "upcoming";
    let date: string | null = null;
    if (key === "booked" || key === "shot") date = job.shootDate;
    if (key === "delivered") date = job.deliveredAt ?? job.deliveryDueDate;
    return { key, label: CLIENT_MILESTONE_LABELS[key], state, date };
  });
}

/** Sort keys of the /portal list. */
export const PORTAL_SORTS = ["progress", "delivered"] as const;
export type PortalSort = (typeof PORTAL_SORTS)[number];

const PROGRESS_ORDER: Record<ClientMilestone, number> = { editing: 0, shot: 1, booked: 2, delivered: 3 };

/**
 * List order. "progress" (default): work in flight first (Editing, Shot,
 * Booked), then delivered (newest first), cancelled last. "delivered":
 * delivered first (newest delivery first), then the rest in progress order.
 */
export function comparePortalJobs(sort: PortalSort): (a: PortalJob, b: PortalJob) => number {
  const rank = (j: PortalJob): number => {
    if (j.milestone === null) return 10;
    if (sort === "delivered") return j.milestone === "delivered" ? 0 : 1 + PROGRESS_ORDER[j.milestone];
    return PROGRESS_ORDER[j.milestone];
  };
  return (a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.milestone === "delivered" && b.milestone === "delivered") {
      const d = (b.deliveredAt ?? "").localeCompare(a.deliveredAt ?? "");
      if (d !== 0) return d;
    }
    const s = (b.shootDate ?? "").localeCompare(a.shootDate ?? "");
    if (s !== 0) return s;
    return a.jobNumber.localeCompare(b.jobNumber);
  };
}

/** True for an http(s) URL — portal links render only these (defence in depth; links are validated on write). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
