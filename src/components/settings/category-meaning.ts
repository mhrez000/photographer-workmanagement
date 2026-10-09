import type { StatusCategory } from "@/lib/constants";

/**
 * What each semantic status category means to the engine (ARCHITECTURE §4.1).
 * Shown wherever an admin picks a category and in the Help glossary — KPIs,
 * kanban, workloads and automations key on the category, never the name.
 */
export const CATEGORY_MEANING: Record<StatusCategory, string> = {
  new: "Just created, still a draft. Counts as Unassigned. The initial status must be in this category.",
  ready: "Ready to hand to an editor. Counts as Unassigned; declines and unassigns return here.",
  assigned: "An editor has it but hasn't accepted yet. Counts as Awaiting editor and in their workload.",
  accepted: "The editor accepted and will start soon. Awaiting editor; they can pause or run a timer.",
  in_progress: "The editor is working on it. Counts as In editing; first entry stamps “started”.",
  submitted: "Work handed in for review. Awaiting review; sets the review deadline from the SLA.",
  review: "The reviewer is looking at it now. Awaiting review.",
  revision: "Sent back with a numbered revision request. Back in the editor's workload.",
  resubmitted: "The editor resolved the revision. Awaiting review again.",
  approved: "Signed off — the editing deadline is met. Records on-time and approval stats.",
  delivered: "Sent to the client. Still active until completed.",
  completed: "Finished. Not active; can be reopened (history keeps every completion).",
  cancelled: "Stopped. Hidden from boards; can be restored to where it was.",
};
