"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { api, errorMessage } from "@/lib/api-client";
import type { ClientOption, ProjectOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Combobox, type ComboboxOption } from "./combobox";
import { NewClientDialog, NewProjectDialog, type DeferredProjectDraft } from "./quick-create-dialogs";

/** Sentinel project id of a not-yet-created inline project (editors, docs/ROLES.md §4.3). */
export const NEW_PROJECT_ID = "__new_project__";

export interface UseClientProjectInput {
  clients: ClientOption[];
  /** Projects of `initialClientId` (preloaded server-side). */
  projects: ProjectOption[];
  initialClientId: string | null;
  initialProjectId: string | null;
  canCreateClient: boolean;
  canCreateProject: boolean;
  /**
   * Editors (docs/ROLES.md §4.3): "New project" does not create anything yet;
   * the project is created together with the job (`POST /api/jobs` `newProject`).
   * Implies a "New project" row even when `canCreateProject` is false.
   */
  inlineNewProject?: boolean;
  /** Extra text for the client picker's empty state (e.g. "Ask your studio owner to add this client."). */
  clientEmptyHint?: string;
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
  /** The inline project to create with the job (only while it is the selected project). */
  newProject: (DeferredProjectDraft & { clientId: string }) | null;
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
  const { canCreateClient, canCreateProject, inlineNewProject = false, clientEmptyHint, disabled, errors, onChange } = input;
  const [draftProject, setDraftProject] = React.useState<(DeferredProjectDraft & { clientId: string }) | null>(null);
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
  const projects = React.useMemo(() => {
    const loaded = clientId ? (projectsByClient[clientId] ?? []) : [];
    if (!draftProject || draftProject.clientId !== clientId || !client) return loaded;
    return [...loaded, { id: NEW_PROJECT_ID, name: draftProject.name, clientId: draftProject.clientId, clientName: client.name }];
  }, [clientId, projectsByClient, draftProject, client]);
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
  const projectOptions: ComboboxOption[] = React.useMemo(
    () => projects.map((p) => (p.id === NEW_PROJECT_ID ? { value: p.id, label: p.name, description: "New — created with the job" } : { value: p.id, label: p.name })),
    [projects],
  );
  const offerNewProject = (canCreateProject || inlineNewProject) && client !== null;
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
            emptyText={clientEmptyHint ? `No client by that name. ${clientEmptyHint}` : "No client by that name."}
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
        description={
          !clientId
            ? "Pick the client first."
            : !loadingProjects && projects.length === 0
              ? offerNewProject
                ? "This client has no projects yet — create one."
                : "This client has no projects yet."
              : projectId === NEW_PROJECT_ID
                ? "A new project — it is created together with the job."
                : undefined
        }
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
              offerNewProject && client
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
        onDeferred={
          inlineNewProject && !canCreateProject && client
            ? (draft) => {
                const next = { ...draft, clientId: client.id };
                setDraftProject(next);
                setProjectId(NEW_PROJECT_ID);
                emit(client, { id: NEW_PROJECT_ID, name: draft.name, clientId: client.id, clientName: client.name });
              }
            : undefined
        }
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

  const newProject = projectId === NEW_PROJECT_ID && draftProject && draftProject.clientId === clientId ? draftProject : null;
  return { clientId, projectId, client, project, newProject, fields, dialogs };
}
