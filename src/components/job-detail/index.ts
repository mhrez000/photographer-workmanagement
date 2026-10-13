/**
 * What is left of the old tabbed job page: the full, permanent history
 * (`/jobs/[id]/history`), the @mention box the Messages thread uses, and the
 * formatting helpers they share. Everything else became the single-scroll
 * job page in `@/components/job-simple` (docs/SIMPLIFICATION-PLAN.md §5).
 */
export { MentionTextarea, type MentionTextareaProps } from "./mention-textarea";
export { HistoryTab, buildMoments, type HistoryTabProps } from "./history-tab";
export { formatSeconds, valueChanges } from "./format";
