import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  ArrowLeftRight,
  AtSign,
  Ban,
  BadgeCheck,
  CalendarClock,
  CircleCheckBig,
  Flag,
  Gauge,
  Hourglass,
  MessageSquare,
  MessageSquareReply,
  MessagesSquare,
  PackageCheck,
  Share2,
  Pause,
  RefreshCcw,
  Repeat,
  RotateCcw,
  Send,
  UserMinus,
  UserPlus,
  UserRoundX,
  UserX,
  Zap,
} from "lucide-react";
import type { NotificationType } from "@/lib/constants";

export type NotificationTone = "accent" | "info" | "success" | "attention" | "danger" | "revision" | "neutral";

/** Icon + tone per notification type (spec §21). */
export const NOTIFICATION_ICON: Record<NotificationType, { icon: LucideIcon; tone: NotificationTone }> = {
  job_assigned: { icon: UserPlus, tone: "accent" },
  job_reassigned: { icon: ArrowLeftRight, tone: "info" },
  job_unassigned: { icon: UserMinus, tone: "neutral" },
  job_declined: { icon: UserX, tone: "attention" },
  deadline_changed: { icon: CalendarClock, tone: "info" },
  priority_changed: { icon: Flag, tone: "attention" },
  comment_added: { icon: MessageSquare, tone: "neutral" },
  mentioned: { icon: AtSign, tone: "accent" },
  revision_requested: { icon: RotateCcw, tone: "revision" },
  work_submitted: { icon: Send, tone: "info" },
  work_resubmitted: { icon: Repeat, tone: "info" },
  work_approved: { icon: BadgeCheck, tone: "success" },
  job_overdue: { icon: AlarmClock, tone: "danger" },
  review_overdue: { icon: Hourglass, tone: "danger" },
  job_completed: { icon: CircleCheckBig, tone: "success" },
  job_reopened: { icon: RefreshCcw, tone: "attention" },
  job_cancelled: { icon: Ban, tone: "neutral" },
  job_paused: { icon: Pause, tone: "neutral" },
  workload_threshold: { icon: Gauge, tone: "attention" },
  editor_unavailable: { icon: UserRoundX, tone: "danger" },
  automation: { icon: Zap, tone: "neutral" },
  // roles v2 (docs/ROLES.md §7.5, §7.6)
  client_feedback: { icon: MessagesSquare, tone: "attention" },
  client_work_shared: { icon: Share2, tone: "info" },
  client_work_delivered: { icon: PackageCheck, tone: "success" },
  client_feedback_reply: { icon: MessageSquareReply, tone: "accent" },
  job_created: { icon: UserPlus, tone: "attention" },
};

export const NOTIFICATION_TONE_CLASS: Record<NotificationTone, string> = {
  accent: "bg-accent-soft text-accent-ink",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  attention: "bg-attention-soft text-attention",
  danger: "bg-danger-soft text-danger",
  revision: "bg-status-revision-soft text-status-revision",
  neutral: "bg-surface-muted text-ink-muted",
};
