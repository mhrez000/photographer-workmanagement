import * as React from "react";
import { formatDateTime, formatRelative, toDate, type DateInput } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface RelativeTimeProps {
  value: DateInput;
  /** Org timezone for the absolute tooltip. */
  timeZone?: string;
  /** Text before the relative value ("Updated"). */
  prefix?: string;
  className?: string;
}

/**
 * "3h ago" inside a `<time>` whose title is the absolute date-time in the org
 * timezone. Server-safe; hydration warnings are suppressed because the
 * relative text can legitimately differ by a minute between server and client.
 */
export function RelativeTime({ value, timeZone, prefix, className }: RelativeTimeProps) {
  const date = toDate(value);
  if (!date) return <span className={cn("text-ink-subtle", className)}>—</span>;
  return (
    <time
      dateTime={date.toISOString()}
      title={formatDateTime(date, timeZone)}
      suppressHydrationWarning
      className={cn("whitespace-nowrap numeric", className)}
    >
      {prefix ? `${prefix} ` : null}
      {formatRelative(date)}
    </time>
  );
}
