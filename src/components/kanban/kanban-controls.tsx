"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { useUrlState } from "@/hooks/use-url-state";

/** "Show cancelled" toggle → `?includeCancelled=1` (adds a read-only Cancelled column). */
export function ShowCancelledToggle() {
  const url = useUrlState();
  const on = url.get("includeCancelled") === "1";
  return (
    <Switch
      size="sm"
      checked={on}
      onCheckedChange={(next) => url.set("includeCancelled", next ? "1" : null)}
      label="Show cancelled"
      wrapperClassName="h-8 shrink-0 text-sm text-ink-secondary"
    />
  );
}
