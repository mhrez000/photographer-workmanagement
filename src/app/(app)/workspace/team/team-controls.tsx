"use client";

import * as React from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useUrlState } from "@/hooks/use-url-state";

/** Group Team Work by editor (default) or photographer — writes `?role=`. */
export function TeamRoleSwitch({ value }: { value: "editor" | "photographer" }) {
  const url = useUrlState();
  return (
    <SegmentedControl
      aria-label="Group by person"
      size="sm"
      value={value}
      onValueChange={(next) => url.set("role", next === "editor" ? null : next)}
      options={[
        { value: "editor", label: "Editors" },
        { value: "photographer", label: "Photographers" },
      ]}
    />
  );
}

/** Expand / collapse every person group (native <details>, so no state to sync). */
export function ExpandAllToggle({ targetId }: { targetId: string }) {
  const [allOpen, setAllOpen] = React.useState(true);
  const toggle = () => {
    const root = document.getElementById(targetId);
    const next = !allOpen;
    root?.querySelectorAll<HTMLDetailsElement>("details[data-team-group]").forEach((d) => {
      d.open = next;
    });
    setAllOpen(next);
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      leadingIcon={allOpen ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
      aria-controls={targetId}
    >
      {allOpen ? "Collapse all" : "Expand all"}
    </Button>
  );
}
