/**
 * Staff-side view models for client sharing (docs/ROLES.md §7.1–§7.3, §11):
 * the job detail "Client access" card, the project share switch and the
 * client "Client portal" card. Built by src/server/queries/portal.ts; shared
 * with the client islands in src/components/sharing (types only + pure
 * helpers, no server imports).
 */
import type { LinkKind, StatusCategory } from "@/lib/constants";
import type { UserRef } from "@/lib/types";

export interface SharingLink {
  id: string;
  kind: LinkKind;
  label: string | null;
  url: string;
  provider: string | null;
  sharedWithClient: boolean;
  /** The adder could share at insert time (default delivery set, §7.3). */
  addedBySharer: boolean;
  addedByName: string;
  createdAt: string;
  /** `link.share_with_client` on this link. */
  canShare: boolean;
}

export interface SharingNote {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
  version: number;
  canEdit: boolean;
  canArchive: boolean;
}

export interface SharingFeedbackMessage {
  id: string;
  /** null when deleted. */
  body: string | null;
  authorName: string;
  isClient: boolean;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface SharingFeedbackThread extends SharingFeedbackMessage {
  replies: SharingFeedbackMessage[];
  /** The last message is from the client (§7.5 "waiting"). */
  waiting: boolean;
  /** Started by a user of another client (the job changed client): staff side only, the client can't see it. */
  fromOtherClient: boolean;
}

export interface JobClientAccess {
  jobId: string;
  jobNumber: string;
  jobVersion: number;
  statusCategory: StatusCategory;
  /** Current editor (default assignee of "Turn into revision request"). */
  editor: UserRef | null;
  client: {
    id: string;
    name: string;
    portalEnabled: boolean;
    feedbackEnabled: boolean;
    archived: boolean;
    /** Active portal users of the client. */
    activePortalUsers: number;
  };
  project: { id: string; name: string; sharedWithClient: boolean };
  /** jobs.shared_with_client */
  sharedWithClient: boolean;
  /** Job shared directly or through its project. */
  visibleToClient: boolean;
  /** Current links (any kind) with their client visibility. */
  links: SharingLink[];
  /** Non-archived delivery notes (visible to the client). */
  deliveryNotes: SharingNote[];
  /** Client feedback threads (staff view: every client_feedback thread on the job). */
  feedback: SharingFeedbackThread[];
  can: {
    shareJob: boolean;
    reply: boolean;
    addDeliveryNote: boolean;
    turnIntoRevision: boolean;
    shareProject: boolean;
    managePortal: boolean;
  };
}

export interface ProjectClientSharing {
  projectId: string;
  projectName: string;
  version: number;
  sharedWithClient: boolean;
  client: { id: string; name: string; portalEnabled: boolean; archived: boolean };
  /** Jobs of the project (any status). */
  jobCount: number;
  /** Jobs shared one by one (stay visible when the project share is turned off). */
  individuallySharedJobs: number;
  canShare: boolean;
}

export interface ClientPortalUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  version: number;
}

export interface ClientPortalAccess {
  clientId: string;
  clientName: string;
  version: number;
  portalEnabled: boolean;
  feedbackEnabled: boolean;
  archived: boolean;
  users: ClientPortalUser[];
  sharedProjectCount: number;
  sharedJobCount: number;
}

/** "Copy invite message" text (§6.1): the temp password is shown once and only here. */
export function clientInviteMessage(opts: { studio: string; origin: string; email: string; password: string }): string {
  return (
    `You've been invited to ${opts.studio} on Proofline. Sign in at ${opts.origin}/login with ${opts.email} ` +
    `and the temporary password ${opts.password}. You'll be asked to choose a new password.`
  );
}

/* ------------------------------------------------------------------ */
/*  Deliver dialog (docs/ROLES.md §7.3)                                 */
/* ------------------------------------------------------------------ */

/** What the job header's Deliver dialog needs; null when the client has no portal (plain delivery). */
export interface DeliverContext {
  clientName: string;
  /** The job is client-visible already (shared directly or through its project). */
  visibleToClient: boolean;
  /** The deliverer may share the job (`job.share_with_client`). */
  canShareJob: boolean;
  /** When the job was last approved — links added after it are flagged. */
  approvedAt: string | null;
  /** Current links of the job (any kind) the deliverer may publish. */
  links: SharingLink[];
}

/** Kinds pre-selected in the Deliver dialog; `finished_files` only when there are none of these. */
export const DELIVER_DIALOG_PRESELECT_KINDS: readonly LinkKind[] = ["gallery", "client_delivery"];

/**
 * Pre-selection of the Deliver dialog: the current gallery / client-delivery links
 * (already-shared ones stay shared either way); when the job has none, its current
 * finished-files links, so a delivered job is never published with nothing to open
 * by accident (ROLES.md §7.3, product review blocking item 4).
 */
export function defaultDeliverySelection(links: readonly Pick<SharingLink, "id" | "kind" | "sharedWithClient">[]): string[] {
  const preferred = links.filter((l) => DELIVER_DIALOG_PRESELECT_KINDS.includes(l.kind));
  const chosen = preferred.length > 0 ? preferred : links.filter((l) => l.kind === "finished_files");
  return chosen.map((l) => l.id);
}

/** Links added after the last approval (flagged "Added after approval" in the dialog). */
export function addedAfterApproval(link: Pick<SharingLink, "createdAt">, approvedAt: string | null): boolean {
  return approvedAt !== null && link.createdAt > approvedAt;
}
