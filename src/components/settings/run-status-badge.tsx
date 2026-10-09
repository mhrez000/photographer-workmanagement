import * as React from "react";
import { Badge } from "@/components/ui/badge";
import type { AutomationRunStatus } from "@/lib/constants";

const META: Record<AutomationRunStatus, { label: string; variant: "success" | "danger" | "neutral" | "info" | "warning" }> = {
  succeeded: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  skipped: { label: "Skipped", variant: "neutral" },
  matched: { label: "Matched", variant: "info" },
  pending: { label: "Pending", variant: "warning" },
};

/** Coloured badge for an automation run status. */
export function RunStatusBadge({ status, size = "sm" }: { status: AutomationRunStatus; size?: "sm" | "md" }) {
  const m = META[status];
  return (
    <Badge variant={m.variant} size={size} dot>
      {m.label}
    </Badge>
  );
}
