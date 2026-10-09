import type { AutomationAction, AutomationCondition, AutomationTrigger } from "./automation-describe";

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

/** The five example rules from the product brief (spec §22). */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "submitted-notify-photographer",
    name: "Tell the photographer when work is submitted",
    description: "Status → Submitted for review notifies the job's photographer.",
    trigger: { type: "status_changed", toCategory: "submitted" },
    conditions: [],
    actions: [{ type: "notify", target: "photographer", message: "Work is ready for your review." }],
  },
  {
    id: "overdue-notify",
    name: "Chase overdue jobs",
    description: "When a job becomes overdue, notify the editor and the managers.",
    trigger: { type: "job_overdue" },
    conditions: [],
    actions: [
      { type: "notify", target: "editor", message: "This job is now overdue." },
      { type: "notify", target: "managers", message: "A job just became overdue." },
    ],
  },
  {
    id: "revision-original-editor",
    name: "Send revisions back to the original editor",
    description: "When a revision is requested, assign the job back to the editor who first worked on it.",
    trigger: { type: "revision_requested" },
    conditions: [],
    actions: [{ type: "assign_editor", target: "original_editor" }],
  },
  {
    id: "approved-complete",
    name: "Complete jobs when approved",
    description: "Approval moves the job straight to Completed (skip if you deliver separately).",
    trigger: { type: "status_changed", toCategory: "approved" },
    conditions: [],
    actions: [{ type: "transition", toCategory: "completed", reason: "Auto-completed on approval" }],
  },
  {
    id: "workload-notify-managers",
    name: "Warn managers about overloaded editors",
    description: "When an editor crosses the overloaded threshold, notify managers.",
    trigger: { type: "workload_threshold", band: "overloaded" },
    conditions: [],
    actions: [{ type: "notify", target: "managers", message: "An editor is overloaded — consider reassigning work." }],
  },
];
