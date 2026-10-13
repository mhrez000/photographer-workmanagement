"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import type { ClientOption } from "@/lib/types";
import { Combobox, type ComboboxOption } from "./combobox";

/** Sentinel value of a client that does not exist yet (created with the job, SIMPLIFICATION-PLAN §5 "pick one, or type a new name"). */
export const NEW_CLIENT_ID = "__new_client__";

export type ClientChoice = { kind: "existing"; id: string } | { kind: "new"; name: string } | null;

export interface ClientPickerProps {
  id?: string;
  clients: ClientOption[];
  value: ClientChoice;
  onChange: (next: ClientChoice) => void;
  /** Owners and photographers with "Create jobs" may type a new name; editors pick an existing client. */
  canCreate: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

function ColourDot({ colour }: { colour?: string | null }) {
  return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/5" style={{ backgroundColor: colour || "var(--border-strong)" }} />;
}

/**
 * Field 1 of the New job form: pick a client, or type a name that is not in the list and press
 * "New client …". Nothing is created until the job is; the row simply stays selected.
 */
export function ClientPicker({ id, clients, value, onChange, canCreate, disabled, ...aria }: ClientPickerProps) {
  const options = React.useMemo<ComboboxOption[]>(() => {
    const rows: ComboboxOption[] = clients.map((c) => ({ value: c.id, label: c.name, leading: <ColourDot colour={c.colour} /> }));
    if (value?.kind === "new") rows.unshift({ value: NEW_CLIENT_ID, label: value.name, description: "New client — added when you create the job", leading: <Plus aria-hidden="true" className="size-3.5 text-accent-ink" /> });
    return rows;
  }, [clients, value]);

  const selected = value === null ? null : value.kind === "new" ? NEW_CLIENT_ID : value.id;

  return (
    <Combobox
      {...aria}
      id={id}
      options={options}
      value={selected}
      onChange={(next) => {
        if (next === null) onChange(null);
        else if (next === NEW_CLIENT_ID) onChange(value?.kind === "new" ? value : null);
        else onChange({ kind: "existing", id: next });
      }}
      disabled={disabled}
      placeholder={clients.length === 0 && canCreate ? "Type the client's name" : "Who is this for?"}
      searchPlaceholder={canCreate ? "Search, or type a new name…" : "Search clients…"}
      emptyText={canCreate ? "No client by that name yet — add it below." : "No client by that name. Ask the studio owner to add them."}
      footer={
        canCreate
          ? (query, close) => {
              const name = query.trim();
              const exists = clients.some((c) => c.name.trim().toLowerCase() === name.toLowerCase());
              if (!name || exists) return null;
              return (
                <button
                  type="button"
                  onClick={() => {
                    onChange({ kind: "new", name });
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm font-medium text-accent-ink hover:bg-accent-soft/60 focus-ring"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  <span className="truncate">New client &ldquo;{name}&rdquo;</span>
                </button>
              );
            }
          : undefined
      }
    />
  );
}
