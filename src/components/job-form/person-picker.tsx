"use client";

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { WorkloadBand } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { api, errorMessage } from "@/lib/api-client";
import { WORKLOAD_BAND_META, displayRoleLabel } from "@/lib/constants";
import type { UserOption } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { Combobox, type ComboboxOption } from "./combobox";

export type PersonPickerKind = "editor" | "photographer";

/** Role filter per picker kind (roles v2: admins are photographers too, docs/ROLES.md §3.4). */
const ROLE_QUERY: Record<PersonPickerKind, string> = {
  editor: "editor",
  photographer: "photographer",
};

/** "Owner / Photographer · Studio Director" — persona + title (docs/ROLES.md §6.1); a title that repeats the persona is shown once. */
export function personDescription(p: UserOption): string {
  const persona = displayRoleLabel({ ...p, title: null });
  const title = p.title?.trim();
  return title && title !== persona ? `${persona} · ${title}` : persona;
}

/** Loads `/api/users/options` for a picker kind once on mount. */
export function usePeopleOptions(kind: PersonPickerKind, enabled = true) {
  const [state, setState] = React.useState<{ options: UserOption[]; error: string | null; loaded: boolean }>({ options: [], error: null, loaded: false });
  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    api
      .get<UserOption[]>("/api/users/options", { query: { role: ROLE_QUERY[kind] }, signal: controller.signal })
      .then((rows) => setState({ options: (rows ?? []).filter((u) => u.isActive), error: null, loaded: true }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ options: [], error: errorMessage(err), loaded: true });
      });
    return () => controller.abort();
  }, [kind, enabled]);
  return { ...state, loading: enabled && !state.loaded };
}

export interface PersonPickerProps {
  id?: string;
  kind: PersonPickerKind;
  people: UserOption[];
  loading?: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** Label of the "nobody" row (omit to make a choice required). */
  clearLabel?: string;
  placeholder?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

/** Person combobox; editors show their workload band (when the viewer may see workloads). */
export function PersonPicker({ kind, people, loading, value, onChange, disabled, clearLabel, placeholder, ...aria }: PersonPickerProps) {
  const options: ComboboxOption[] = React.useMemo(
    () =>
      people.map((p) => ({
        value: p.id,
        label: p.name,
        keywords: p.role,
        leading: <Avatar name={p.name} size="xs" colour={p.avatarColour || undefined} />,
        description:
          kind === "editor"
            ? p.workload
              ? `${pluralise(p.workload.active, "active job")}${p.workload.overdue > 0 ? ` · ${p.workload.overdue} overdue` : ""}`
              : (p.title ?? undefined)
            : personDescription(p),
        trailing:
          kind === "editor" && p.workload ? (
            <WorkloadBand band={p.workload.band} showLabel={false} />
          ) : kind === "photographer" && p.isPrimaryOwner ? (
            <Badge variant="solid" size="sm">
              Owner
            </Badge>
          ) : undefined,
      })),
    [people, kind],
  );
  return (
    <Combobox
      {...aria}
      options={options}
      value={value}
      onChange={onChange}
      loading={loading}
      disabled={disabled}
      clearLabel={clearLabel}
      placeholder={placeholder ?? (kind === "editor" ? "Choose an editor" : "Choose a photographer")}
      searchPlaceholder={kind === "editor" ? "Search editors…" : "Search people…"}
      emptyText={loading ? "Loading…" : "Nobody matches."}
    />
  );
}

/** Calm warning under the editor picker when the chosen editor is stretched. */
export function WorkloadNotice({ person }: { person: UserOption | null }) {
  if (!person?.workload || person.workload.band === "healthy") return null;
  const overloaded = person.workload.band === "overloaded";
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        overloaded ? "border-danger/25 bg-danger-soft/60 text-danger-fg" : "border-warning/25 bg-warning-soft/60 text-warning-fg",
      )}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong className="font-medium">{person.name}</strong> is {WORKLOAD_BAND_META[person.workload.band].label.toLowerCase()} —{" "}
        {pluralise(person.workload.active, "active job")}
        {person.workload.overdue > 0 ? `, ${person.workload.overdue} overdue` : ""}.{" "}
        {overloaded ? "Consider someone with more capacity." : "They can take it, but they are close to their limit."}
      </span>
    </p>
  );
}
