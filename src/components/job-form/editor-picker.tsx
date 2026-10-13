"use client";

import * as React from "react";
import { Avatar } from "@/components/ui/avatar";
import type { EditorPickerOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Combobox, type ComboboxOption } from "./combobox";

export interface EditorPickerProps {
  id?: string;
  editors: EditorPickerOption[];
  value: string | null;
  onChange: (editorId: string | null) => void;
  disabled?: boolean;
  /** Label of the "nobody yet" row (SIMPLIFICATION-PLAN §5: "Decide later"). */
  clearLabel?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

/** "On their desk 3 · Late 1" (or "On their desk 4 of 6" when a usual capacity is set). */
export function deskLabel(o: Pick<EditorPickerOption, "onDesk" | "late" | "usualCapacity">): string {
  const desk = o.usualCapacity !== null ? `On their desk ${o.onDesk} of ${o.usualCapacity}` : `On their desk ${o.onDesk}`;
  return o.late > 0 ? `${desk} · Late ${o.late}` : desk;
}

/** Field 6 of the New job form: every active editor with the two numbers that matter when handing work out. */
export function EditorPicker({ id, editors, value, onChange, disabled, clearLabel = "Decide later", ...aria }: EditorPickerProps) {
  const options = React.useMemo<ComboboxOption[]>(
    () =>
      editors.map((o) => ({
        value: o.editor.id,
        label: o.editor.name,
        description: deskLabel(o),
        leading: <Avatar name={o.editor.name} size="xs" colour={o.editor.avatarColour || undefined} />,
        trailing:
          o.late > 0 || o.full ? (
            <span className={cn("shrink-0 text-2xs font-semibold", o.late > 0 ? "text-danger-fg" : "text-warning-fg")}>{o.late > 0 ? `${o.late} late` : "Full"}</span>
          ) : undefined,
      })),
    [editors],
  );
  return (
    <Combobox
      {...aria}
      id={id}
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      clearLabel={clearLabel}
      placeholder={clearLabel}
      searchPlaceholder="Search editors…"
      emptyText={editors.length === 0 ? "No editors yet. Invite one from Settings → People." : "Nobody matches."}
    />
  );
}
