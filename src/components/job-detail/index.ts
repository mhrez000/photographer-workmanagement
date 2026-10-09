/**
 * Job detail page building blocks (`/jobs/[id]`). Server components render the
 * read views; the tabs that mutate (links, notes, comments, activity paging,
 * revision actions) are client islands calling the REST API.
 */
export { JobHeader, type JobHeaderProps } from "./job-header";
export { JobTabs, type JobTabsProps } from "./job-tabs";
export { FactsRail, type FactsRailProps } from "./facts-rail";
export { OverviewTab, type OverviewTabProps } from "./overview-tab";
export { FinishedWorkPanel, FinishedWorkItem, previousVersions, type FinishedWorkPanelProps } from "./finished-work";
export { LinksTab, type LinksTabProps, type LinkPermissions } from "./links-tab";
export { NotesTab, type NotesTabProps, type NotePermissions } from "./notes-tab";
export { CommentsTab, type CommentsTabProps } from "./comments-tab";
export { MentionTextarea, type MentionTextareaProps } from "./mention-textarea";
export { RevisionsTab, type RevisionsTabProps } from "./revisions-tab";
export { RevisionActions, type RevisionActionsProps } from "./revision-actions";
export { TimelineTab, type TimelineTabProps } from "./timeline-tab";
export { ActivityTab, type ActivityTabProps } from "./activity-tab";
export { HistoryTab, buildMoments, type HistoryTabProps } from "./history-tab";
export { TimeTab, type TimeTabProps } from "./time-tab";
export {
  JOB_TABS,
  JOB_TAB_LABELS,
  ACTIVITY_GROUPS,
  ACTIVITY_GROUP_KEYS,
  isJobTab,
  isActivityGroup,
  formatSeconds,
  valueChanges,
  type JobTab,
  type ActivityGroup,
} from "./format";
