/**
 * Dashboard feature components. Widgets are server components fed by
 * `getDashboard()`; `DashboardBoard` is the client island that lays them out
 * from the user's DashboardLayout and hosts Customise mode.
 */
export { KpiStrip, KPI_DEFS, type KpiStripProps } from "./kpi-strip";
export { BottleneckBanners, type BottleneckBannersProps } from "./bottleneck-banners";
export { WorkloadOverview, sortWorkloads, type WorkloadOverviewProps } from "./workload-overview";
export { JobListWidget, DashboardJobRows, type JobListWidgetProps, type DashboardJobRowsProps, type JobListVariant } from "./job-list-widget";
export { ActivityWidget, DASHBOARD_ACTIVITY_EVENT_TYPES, type ActivityWidgetProps } from "./activity-widget";
export {
  EditorPerformanceWidget,
  CompletionRateWidget,
  RevisionRateWidget,
  MyPerformanceWidget,
  type EditorPerformanceWidgetProps,
  type MyPerformanceWidgetProps,
} from "./performance-widgets";
export { MyWorkloadWidget, type MyWorkloadWidgetProps } from "./my-workload-widget";
export {
  MoreInBusinessLink,
  QuestionsWidget,
  TurnaroundWidget,
  UpcomingDeadlinesWidget,
  type QuestionsWidgetProps,
} from "./role-widgets";
export { CalendarMini, bucketCalendar, type CalendarDay, type CalendarMiniProps } from "./calendar-mini";
export { DashboardBoard, orderWidgets, packWidgets, type DashboardBoardProps, type DashboardWidget } from "./dashboard-board";
export { WIDGET_META, WIDGET_WIDTHS, widgetSpanClass, type WidgetMeta } from "./widget-meta";
