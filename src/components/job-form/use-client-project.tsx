"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { api, errorMessage } from "@/lib/api-client";
import type { ClientOption, ProjectOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Combobox, type ComboboxOption } from "./combobox";
import { NewClientDialog, NewProjectDialog } from "./quick-create-dialogs";

export interface UseClientProjectInput {
  clients: ClientOption[];
  /** Projects of `initialClientId` (preloaded server-side). */
  projects: ProjectOption[];
  initialClientId: string | null;
  initialProjectId: string | null;
  canCreateClient: boolean;
  canCreateProject: boolean;
  disabled?: boolean;
  errors?: { clientId?: string; projectId?: string };
  /** Called whenever the project (or client) selection changes. */
  onChange?: (next: { client: ClientOption | null; project: ProjectOption | null }) => void;
}

export interface ClientProjectState {
  clientId: string | null;
  projectId: string | null;
  client: ClientOption | null;
  project: ProjectOption | null;
  /** The two pickers, ready to drop into a grid. */
  fields: React.ReactNode;
  /** Quick-create dialogs — render OUTSIDE the surrounding <form>. */
  dialogs: React.ReactNode;
}

function ColourDot({ colour }: { colour?: string | null }) {
  return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/5" style={{ backgroundColor: colour || "var(--border-strong)" }} />;
}

function CreateRow({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm font-medium text-accent-ink hover:bg-accent-soft/60 focus-ring disabled:opacity-50"
    >
      <Plus aria-hidden="true" className="size-4" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Client → Project cascade for the job forms (spec §23). Clients are
 * preloaded; projects reload from `/api/projects/options?clientId=` whenever
 * the client changes. "+ New client" / "+ New project" create inline and
 * select the new row.
 */
export function useClientProject(input: UseClientProjectInput): ClientProjectState {
  const { canCreateClient, canCreateProject, disabled, errors, onChange } = input;
  const [clients, setClients] = React.useState<ClientOption[]>(input.clients);
  const [clientId, setClientId] = React.useState<string | null>(input.initialClientId);
  const [projectsByClient, setProjectsByClient] = React.useState<Record<string, ProjectOption[]>>(() =>
    input.initialClientId ? { [input.initialClientId]: input.projects } : {},
  );
  const [projectId, setProjectId] = React.useState<string | null>(input.initialProjectId);
  const [loadingFor, setLoadingFor] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [clientDialog, setClientDialog] = React.useState<{ open: boolean; name: string }>({ open: false, name: "" });
  const [projectDialog, setProjectDialog] = React.useState<{ open: boolean; name: string }>({ open: false, name: "" });
  const requestRef = React.useRef<AbortController | null>(null);

  const client = clients.find((c) => c.id === clientId) ?? null;
  const projects = React.useMemo(() => (clientId ? (projectsByClient[clientId] ?? []) : []), [clientId, projectsByClient]);
  const project = projects.find((p) => p.id === projectId) ?? null;

  const emit = (nextClient: ClientOption | null, nextProject: ProjectOption | null) => onChange?.({ client: nextClient, project: nextProject });

  const loadProjects = (id: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoadingFor(id);
    setLoadError(null);
    api
      .get<ProjectOption[]>("/api/projects/options", { query: { clientId: id }, signal: controller.signal })
      .then((rows) => {
        setProjectsByClient((prev) => ({ ...prev, [id]: rows ?? [] }));
        setLoadingFor((cur) => (cur === id ? null : cur));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(errorMessage(err));
        setLoadingFor((cur) => (cur === id ? null : cur));
      });
  };

  const selectClient = (id: string | null) => {
    if (id === clientId) return;
    setClientId(id);
    setProjectId(null);
    const nextClient = clients.find((c) => c.id === id) ?? null;
    emit(nextClient, null);
    if (id && !projectsByClient[id]) loadProjects(id);
  };

  const selectProject = (id: string | null) => {
    setProjectId(id);
    emit(client, projects.find((p) => p.id === id) ?? null);
  };

  const clientOptions: ComboboxOption[] = React.useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name, leading: <ColourDot colour={c.colour} /> })),
    [clients],
  );
  const projectOptions: ComboboxOption[] = React.useMemo(() => projects.map((p) => ({ value: p.id, label: p.name })), [projects]);
  const loadingProjects = clientId !== null && loadingFor === clientId;

  const fields = (
    <>
      <FormField label="Client" required error={errors?.clientId}>
        {(control) => (
          <Combobox
            {...control}
            options={clientOptions}
            value={clientId}
            onChange={selectClient}
            disabled={disabled}
            placeholder="Choose a client"
            searchPlaceholder="Search clients…"
            emptyText="No client by that name."
            footer={
              canCreateClient
                ? (query, close) => (
                    <CreateRow
                      label={query ? `New client "${query}"` : "New client"}
                      onClick={() => {
                        close();
                        setClientDialog({ open: true, name: query });
                      }}
                    />
                  )
                : undefined
            }
          />
        )}
      </FormField>
      <FormField
        label="Project"
        required
        error={errors?.projectId ?? loadError ?? undefined}
        description={!clientId ? "Pick the client first." : !loadingProjects && projects.length === 0 ? "This client has no projects yet — create one." : undefined}
      >
        {(control) => (
          <Combobox
            {...control}
            options={projectOptions}
            value={projectId}
            onChange={selectProject}
            disabled={disabled || !clientId}
            loading={loadingProjects}
            placeholder={clientId ? (loadingProjects ? "Loading projects…" : "Choose a project") : "Choose a client first"}
            searchPlaceholder="Search projects…"
            emptyText={client ? `No projects for ${client.name} match.` : "Choose a client first."}
            className={cn(!clientId && "opacity-90")}
            footer={
              canCreateProject && client
                ? (query, close) => (
                    <CreateRow
                      label={query ? `New project "${query}"` : `New project for ${client.name}`}
                      onClick={() => {
                        close();
                        setProjectDialog({ open: true, name: query });
                      }}
                    />
                  )
                : undefined
            }
          />
        )}
      </FormField>
    </>
  );

  const dialogs = (
    <>
      <NewClientDialog
        open={clientDialog.open}
        initialName={clientDialog.name}
        onOpenChange={(open) => setClientDialog((d) => ({ ...d, open }))}
        onCreated={(created) => {
          setClients((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
          setClientId(created.id);
          setProjectId(null);
          setProjectsByClient((prev) => ({ ...prev, [created.id]: [] }));
          emit(created, null);
        }}
      />
      <NewProjectDialog
        open={projectDialog.open}
        initialName={projectDialog.name}
        client={client}
        onOpenChange={(open) => setProjectDialog((d) => ({ ...d, open }))}
        onCreated={(created) => {
          setProjectsByClient((prev) => ({
            ...prev,
            [created.clientId]: [...(prev[created.clientId] ?? []), created].sort((a, b) => a.name.localeCompare(b.name)),
          }));
          setProjectId(created.id);
          emit(client, created);
        }}
      />
    </>
  );

  return { clientId, projectId, client, project, fields, dialogs };
}
