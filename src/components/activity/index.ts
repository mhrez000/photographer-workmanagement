/**
 * Activity feed components (spec §6, §31, §37). The feed, item and filters
 * are client islands; the diff, event groups and filter parser are pure.
 */
export { ActivityFeed, type ActivityFeedProps } from "./activity-feed";
export { ActivityItem, type ActivityItemProps } from "./activity-item";
export { ActivityFilters, type ActivityFiltersProps, type ActivityFilterPerson } from "./activity-filters";
export { buildDiff, formatValue, humanise, type DiffRow, type DiffValue, type DiffFormatContext } from "./activity-diff";
export { ACTIVITY_EVENT_GROUPS, eventGroupsFor, eventTypesForGroups, groupOfEventType, historyCategoryOf, type ActivityEventGroup, type HistoryCategory } from "./event-groups";
export { parseActivityPageFilters, compactQuery, type ActivityPageFilters } from "./page-filters";
export { ActivityFeedSkeleton } from "./activity-skeleton";
