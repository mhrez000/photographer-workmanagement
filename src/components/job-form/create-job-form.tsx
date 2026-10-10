"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Lock, Sparkles } from "lucide-react";
import { CategoryPill, DueChip, PersonChip, PriorityPill, jobHref } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { NOTE_KIND_META, PRIORITIES, PRIORITY_META, type LinkKind, type NoteKind, type Priority, type Role } from "@/lib/constants";
import { endOfCivilDayIso } from "@/lib/dates";
import type { ClientOption, Job, JobTypeView, ProjectOption, UserOption, UserRef } from "@/lib/types";
import { pluralise } from "@/lib/utils";
import { FormSection } from "./form-section";
import { dateWarnings, fromCivilInput, hoursError, parseHours, pickErrors, suggestJobName } from "./form-utils";
import { LinksEditor, draftLinkError, filledLinks, newDraftLink, type DraftLink } from "./links-editor";
import { PersonPicker, WorkloadNotice, usePeopleOptions } from "./person-picker";
import { SubmitHint, formKeyDown, useUnsavedChangesWarning } from "./submit-hint";
import { useClientProject } from "./use-client-project";

export interface CreateJobFormProps {
  viewer: { id: string; name: string; role: Role; avatarColour: string; isAdmin?: boolean; title?: string | null };
  timeZone: string;
  jobTypes: JobTypeView[];
  clients: ClientOption[];
  /** Projects of `initialClientId`. */
  projects: ProjectOption[];
  initialClientId: string | null;
  initialProjectId: string | null;
  /**
   * Photographer field (docs/ROLES.md §4):
   * - "pick": admins choose any active photographer (default: themselves);
   * - "self": team members are always the photographer on jobs they create;
   * - "required": editors must choose one (pre-filled with the studio default).
   */
  photographerMode: "pick" | "self" | "required";
  /** Pre-filled photographer for "pick" / "required". */
  defaultPhotographerId: string | null;
  /**
   * Editor field: "pick" (admins, members with Assign editors), "self" (editors:
   * "Assign to me" or "Leave unassigned"), "none" (hidden).
   */
  editorMode: "pick" | "self" | "none";
  /** Note kinds the creator may add with the job (admin: photographer/client/internal; member: photographer/client; editor: editor). */
  noteKinds: readonly NoteKind[];
  /** Link kinds the creator may add (editors: their link kinds + raw files). Omit = every kind. */
  linkKinds?: readonly LinkKind[];
  canCreateClient: boolean;
  canCreateProject: boolean;
  /** Editors: "New project" is created together with the job (docs/ROLES.md §4.3). */
  inlineNewProject?: boolean;
  /** Editors usually create the job after the shoot: pre-fill today's date (civil YYYY-MM-DD). */
  initialShootDate?: string;
  /** Where Cancel goes. */
  cancelHref?: string;
}

interface CreatedJob {
  job: Job;
}

type NoteDrafts = Partial<Record<NoteKind, string>>;

/** Short guidance under each note box on the create form. */
const NOTE_HINTS: Partial<Record<NoteKind, string>> = {
  photographer: "Shot details, style, what to prioritise.",
  client: "What the client asked for, in their words. Kept from editors and from the client.",
  internal: "Pricing, client history — anything only the studio owner should read.",
  editor: "What you noticed in the raw files, how you plan to edit.",
};

const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }));

/** Field order used to focus the first invalid control after a failed submit. */
const FIELD_ORDER = ["clientId", "projectId", "jobTypeId", "name", "photographerId", "editorId", "shootDate", "dueDate", "reviewDueDate", "deliveryDueDate", "estimatedHours", "links"];

/**
 * Create-job form (spec §4, §23, §24; ARCHITECTURE §10 `/jobs/new`).
 * POST /api/jobs, then the initial links and notes against the new job, then
 * redirect to it. ⌘/Ctrl+Enter submits.
 */
export function CreateJobForm(props: CreateJobFormProps) {
  const { viewer, timeZone, jobTypes, photographerMode, editorMode, noteKinds } = props;
  const canPickPhotographer = photographerMode !== "self";
  const canAssignEditor = editorMode === "pick";
  const isEditorCreator = editorMode === "self";
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);

  const [jobTypeId, setJobTypeId] = React.useState<string>(jobTypes.length === 1 ? jobTypes[0].id : "");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [priority, setPriority] = React.useState<Priority>("normal");
  const [photographerId, setPhotographerId] = React.useState<string | null>(canPickPhotographer ? props.defaultPhotographerId : viewer.id);
  const [editorId, setEditorId] = React.useState<string | null>(null);
  /** Editors: take the job themselves at creation, or leave it for the studio to assign. */
  const [selfAssign, setSelfAssign] = React.useState<"me" | "unassigned">("me");
  const [dates, setDates] = React.useState({ shootDate: props.initialShootDate ?? "", dueDate: "", reviewDueDate: "", deliveryDueDate: "" });
  const [hours, setHours] = React.useState(jobTypes.length === 1 && jobTypes[0].defaultEstimatedHours !== null ? String(jobTypes[0].defaultEstimatedHours) : "");
  const [hoursTouched, setHoursTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [links, setLinks] = React.useState<DraftLink[]>(() => [newDraftLink("raw_files")]);
  const [notes, setNotes] = React.useState<NoteDrafts>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const jobType = jobTypes.find((t) => t.id === jobTypeId) ?? null;

  const clientProject = useClientProject({
    clients: props.clients,
    projects: props.projects,
    initialClientId: props.initialClientId,
    initialProjectId: props.initialProjectId,
    canCreateClient: props.canCreateClient,
    canCreateProject: props.canCreateProject,
    inlineNewProject: props.inlineNewProject,
    clientEmptyHint: props.canCreateClient ? undefined : "Ask your studio owner to add this client.",
    disabled: busy,
    errors: { clientId: errors.clientId, projectId: errors.projectId },
    onChange: ({ project }) => {
      clearError("clientId", "projectId");
      if (!nameTouched) setName(suggestJobName(project?.name, jobType));
    },
  });

  const editors = usePeopleOptions("editor", canAssignEditor);
  const photographers = usePeopleOptions("photographer", canPickPhotographer);
  const selectedEditor: UserOption | null = editors.options.find((e) => e.id === editorId) ?? null;
  const selectedPhotographer: UserRef | null = canPickPhotographer
    ? (photographers.options.find((p) => p.id === photographerId) ?? null)
    : { id: viewer.id, name: viewer.name, role: viewer.role, avatarColour: viewer.avatarColour, isActive: true, isAdmin: viewer.isAdmin, title: viewer.title };
  const meAsEditor: UserRef = { id: viewer.id, name: viewer.name, role: viewer.role, avatarColour: viewer.avatarColour, isActive: true };
  const previewEditor: UserRef | null = isEditorCreator ? (selfAssign === "me" ? meAsEditor : null) : selectedEditor;

  const dirty =
    !done &&
    Boolean(
      clientProject.clientId ||
        name.trim() ||
        description.trim() ||
        editorId ||
        Object.values(dates).some(Boolean) ||
        filledLinks(links).length > 0 ||
        Object.values(notes).some((n) => n?.trim()),
    );
  useUnsavedChangesWarning(dirty && !busy);

  function clearError(...keys: string[]) {
    setErrors((prev) => {
      if (!keys.some((k) => k in prev)) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  const onJobTypeChange = (id: string) => {
    setJobTypeId(id);
    clearError("jobTypeId");
    const next = jobTypes.find((t) => t.id === id) ?? null;
    if (!nameTouched) setName(suggestJobName(clientProject.project?.name, next));
    if (!hoursTouched) setHours(next?.defaultEstimatedHours !== null && next?.defaultEstimatedHours !== undefined ? String(next.defaultEstimatedHours) : "");
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!clientProject.clientId) e.clientId = "Choose the client";
    if (!clientProject.projectId) e.projectId = "Choose the project (or create one)";
    if (!jobTypeId) e.jobTypeId = "Choose a job type";
    if (photographerMode === "required" && !photographerId) e.photographerId = "Choose the photographer who shot it";
    if (!name.trim()) e.name = "Give the job a name";
    const h = hoursError(hours);
    if (h) e.estimatedHours = h;
    if (links.some((l) => draftLinkError(l))) e.links = "Fix the highlighted links";
    return e;
  };

  const focusFirstError = (errs: Record<string, string>) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (!first) return;
    const box = first === "projectId" ? "clientId" : first;
    requestAnimationFrame(() => {
      const root = formRef.current?.querySelector<HTMLElement>(`[data-field="${box}"]`);
      const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? root?.querySelector<HTMLElement>("input, button, select, textarea");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    });
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const local = validate();
    setErrors(local);
    if (Object.keys(local).length > 0) {
      focusFirstError(local);
      return;
    }

    setBusy(true);
    let created: CreatedJob;
    try {
      const newProject = clientProject.newProject;
      created = await api.post<CreatedJob>("/api/jobs", {
        name: name.trim(),
        description: description.trim() || undefined,
        clientId: clientProject.clientId ?? undefined,
        // Editors' inline project is created with the job (`newProject` XOR `projectId`, docs/ROLES.md §4.3).
        ...(newProject ? { newProject: { name: newProject.name, address: newProject.address ?? undefined } } : { projectId: clientProject.projectId }),
        jobTypeId,
        priority,
        photographerId: canPickPhotographer ? photographerId : undefined,
        editorId: isEditorCreator ? (selfAssign === "me" ? viewer.id : undefined) : canAssignEditor && editorId ? editorId : undefined,
        shootDate: fromCivilInput(dates.shootDate) ?? undefined,
        dueDate: fromCivilInput(dates.dueDate) ?? undefined,
        reviewDueDate: fromCivilInput(dates.reviewDueDate) ?? undefined,
        deliveryDueDate: fromCivilInput(dates.deliveryDueDate) ?? undefined,
        estimatedHours: parseHours(hours) ?? undefined,
      });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "validation" && Object.keys(err.fieldErrors).length > 0) {
        const server = pickErrors(err.fieldErrors);
        setErrors(server);
        focusFirstError(server);
        toast.error("Check the highlighted fields", err.message !== "Validation failed" ? err.message : undefined);
      } else {
        toast.error("The job was not created", errorMessage(err));
      }
      return;
    }

    // Follow-ups against the new job. A failure here never loses the job.
    const jobId = created.job.id;
    const failures: string[] = [];
    for (const link of filledLinks(links)) {
      try {
        await api.post(`/api/jobs/${jobId}/links`, { kind: link.kind, url: link.url.trim(), label: link.label.trim() || undefined });
      } catch (err) {
        failures.push(`link (${errorMessage(err)})`);
      }
    }
    for (const kind of noteKinds) {
      const body = notes[kind]?.trim();
      if (!body) continue;
      try {
        await api.post(`/api/jobs/${jobId}/notes`, { kind, body });
      } catch (err) {
        failures.push(`${NOTE_KIND_META[kind].label.toLowerCase()} (${errorMessage(err)})`);
      }
    }

    setDone(true);
    if (failures.length > 0) {
      toast.warning(`${created.job.jobNumber} created — ${pluralise(failures.length, "item")} not saved`, `Add again from the job: ${failures.join("; ")}`);
    } else {
      toast.success(`${created.job.jobNumber} created`, created.job.name);
    }
    router.push(jobHref(jobId));
    router.refresh();
  };

  const warnings = dateWarnings(dates);
  const startsAs = previewEditor ? "assigned" : "new";
  const showErr = (key: string) => (submitted || key in errors ? errors[key] : undefined);

  return (
    <>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <form ref={formRef} onSubmit={onSubmit} onKeyDown={formKeyDown} noValidate aria-label="Create job" className="min-w-0">
          <FormSection title="What & who for" description="Organisation → Client → Project → Job. Pick the project this work belongs to.">
            <div className="grid gap-5 sm:grid-cols-2" data-field="clientId">
              {clientProject.fields}
            </div>
            <div data-field="jobTypeId">
              <FormField
                label="Job type"
                required
                error={showErr("jobTypeId")}
                description={
                  jobType ? (
                    <span className="inline-flex flex-wrap items-center gap-x-1.5">
                      <GitBranch aria-hidden="true" className="size-3.5" />
                      Uses the <strong className="font-medium text-ink-secondary">{jobType.workflow.name}</strong> workflow
                      {jobType.defaultEstimatedHours !== null ? <span className="numeric">· typically {jobType.defaultEstimatedHours}h</span> : null}
                    </span>
                  ) : jobTypes.length === 0 ? (
                    "No job types yet — an admin can add them in Settings → Job types."
                  ) : (
                    "Each type follows its own workflow."
                  )
                }
              >
                <Select value={jobTypeId} onChange={(e) => onJobTypeChange(e.target.value)} placeholder="Choose a job type" disabled={busy} required>
                  {jobTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div data-field="name">
              <FormField
                label="Job name"
                required
                error={showErr("name")}
                hint={
                  nameTouched && clientProject.project && jobType && name !== suggestJobName(clientProject.project.name, jobType) ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-accent-ink hover:underline focus-ring rounded-xs"
                      onClick={() => {
                        setName(suggestJobName(clientProject.project?.name, jobType));
                        setNameTouched(false);
                      }}
                    >
                      <Sparkles aria-hidden="true" className="size-3" /> Use suggestion
                    </button>
                  ) : null
                }
                description={!nameTouched && name ? "Suggested from the project and job type — edit freely." : undefined}
              >
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                    clearError("name");
                  }}
                  placeholder="e.g. 123 Smith Street · Twilight"
                  maxLength={200}
                  disabled={busy}
                  autoComplete="off"
                />
              </FormField>
            </div>
            <FormField label="Description" optional description="The brief: what the client wants, style, anything unusual.">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={5000} disabled={busy} />
            </FormField>
          </FormSection>

          <FormSection
            title="People"
            description={
              isEditorCreator
                ? "Who shot it, and whether you edit it yourself. The studio can assign another editor later."
                : canAssignEditor
                  ? "Who shoots it and who edits it. You can assign or change the editor later."
                  : "Who shoots it. The studio owner assigns the editor."
            }
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <div data-field="photographerId">
                <FormField
                  label="Photographer"
                  required={photographerMode === "required"}
                  error={showErr("photographerId") ?? photographers.error ?? undefined}
                  description={
                    photographerMode === "self"
                      ? "You — you are the photographer on jobs you create."
                      : photographerMode === "required"
                        ? "Who shot it. They review your edit and deliver it."
                        : undefined
                  }
                >
                  {(control) =>
                    canPickPhotographer ? (
                      <PersonPicker
                        {...control}
                        kind="photographer"
                        people={photographers.options}
                        loading={photographers.loading}
                        value={photographerId}
                        onChange={(id) => {
                          setPhotographerId(id);
                          clearError("photographerId");
                        }}
                        clearLabel={photographerMode === "pick" ? "No photographer yet" : undefined}
                        disabled={busy}
                      />
                    ) : (
                      <div id={control.id} className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-sm text-ink">
                        <Avatar name={viewer.name} size="xs" colour={viewer.avatarColour || undefined} />
                        <span className="truncate">{viewer.name}</span>
                        <Lock aria-hidden="true" className="ml-auto size-3.5 text-ink-subtle" />
                      </div>
                    )
                  }
                </FormField>
              </div>
              {isEditorCreator ? (
                <div data-field="editorId">
                  <FormField
                    label="Editor"
                    error={showErr("editorId")}
                    description={selfAssign === "me" ? "You edit it — the job starts as Assigned to you." : "The job starts as New; the studio assigns an editor."}
                  >
                    {(control) => (
                      <SegmentedControl
                        id={control.id}
                        aria-label="Editor"
                        value={selfAssign}
                        onValueChange={(v) => {
                          setSelfAssign(v);
                          clearError("editorId");
                        }}
                        options={[
                          { value: "me", label: "Assign to me" },
                          { value: "unassigned", label: "Leave unassigned" },
                        ]}
                        className="self-start"
                      />
                    )}
                  </FormField>
                </div>
              ) : canAssignEditor ? (
                <div data-field="editorId" className="flex flex-col gap-2">
                  <FormField
                    label="Editor"
                    optional
                    error={showErr("editorId") ?? editors.error ?? undefined}
                    description={!selectedEditor ? "Leave empty to assign later — the job starts as New." : undefined}
                  >
                    {(control) => (
                      <PersonPicker
                        {...control}
                        kind="editor"
                        people={editors.options}
                        loading={editors.loading}
                        value={editorId}
                        onChange={(id) => {
                          setEditorId(id);
                          clearError("editorId");
                        }}
                        clearLabel="Assign later"
                        disabled={busy}
                      />
                    )}
                  </FormField>
                  <WorkloadNotice person={selectedEditor} />
                </div>
              ) : null}
            </div>
          </FormSection>

          <FormSection title="Schedule" description={`Dates are in the studio's timezone (${timeZone}). The editing deadline drives Overdue and Due today.`}>
            <div className="grid gap-5 sm:grid-cols-2">
              {(
                [
                  ["shootDate", "Shoot date", "When the photos are taken."],
                  ["dueDate", "Editing deadline", "When the edit is due."],
                  ["reviewDueDate", "Review deadline", "Empty = set automatically when work is submitted."],
                  ["deliveryDueDate", "Delivery date — visible to the client when shared", "When the client receives it."],
                ] as const
              ).map(([key, label, hint]) => (
                <div key={key} data-field={key}>
                  <FormField label={label} optional error={showErr(key)} description={hint}>
                    <DateInput
                      value={dates[key]}
                      onChange={(e) => {
                        setDates((d) => ({ ...d, [key]: e.target.value }));
                        clearError(key);
                      }}
                      disabled={busy}
                    />
                  </FormField>
                </div>
              ))}
            </div>
            {warnings.length > 0 ? (
              <ul className="flex flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft/50 px-3 py-2 text-sm text-warning-fg" role="status">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </FormSection>

          <FormSection title="Priority & effort" description="Priority orders queues; estimated hours feed editor workload.">
            <FormField label="Priority">
              {(control) => (
                <SegmentedControl
                  id={control.id}
                  aria-label="Priority"
                  options={PRIORITY_OPTIONS}
                  value={priority}
                  onValueChange={(v) => setPriority(v)}
                  className="self-start"
                />
              )}
            </FormField>
            <div data-field="estimatedHours" className="sm:max-w-56">
              <FormField label="Estimated hours" optional error={showErr("estimatedHours")} description={jobType?.defaultEstimatedHours !== null && jobType ? `Default for ${jobType.name}: ${jobType.defaultEstimatedHours}h` : undefined}>
                <Input
                  inputMode="decimal"
                  value={hours}
                  onChange={(e) => {
                    setHours(e.target.value);
                    setHoursTouched(true);
                    clearError("estimatedHours");
                  }}
                  trailing="h"
                  mono
                  disabled={busy}
                  autoComplete="off"
                />
              </FormField>
            </div>
          </FormSection>

          <FormSection title="Links" description="External links only — raw files, editing workspace, references. Nothing is uploaded here.">
            <div data-field="links">
              <LinksEditor links={links} kinds={props.linkKinds} onChange={(next) => { setLinks(next); clearError("links"); }} showErrors={submitted} disabled={busy} />
            </div>
          </FormSection>

          {noteKinds.length > 0 ? (
            <FormSection
              title="Notes"
              description={
                noteKinds.some((k) => !NOTE_KIND_META[k].editorReadable)
                  ? "Editors see photographer notes. Client notes and internal notes stay with the studio — editors never see them."
                  : "Visible to the photographer, the editor and the studio owner."
              }
            >
              {noteKinds.map((kind) => (
                <FormField
                  key={kind}
                  label={NOTE_KIND_META[kind].label}
                  optional
                  description={NOTE_HINTS[kind]}
                  hint={
                    !NOTE_KIND_META[kind].editorReadable ? (
                      <span className="inline-flex items-center gap-1">
                        <Lock aria-hidden="true" className="size-3" /> Not visible to editors
                      </span>
                    ) : undefined
                  }
                >
                  <Textarea value={notes[kind] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [kind]: e.target.value }))} rows={kind === "internal" ? 2 : 3} disabled={busy} />
                </FormField>
              ))}
            </FormSection>
          ) : null}

          <div className="sticky bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px))] z-(--z-page-sticky) -mx-4 mt-2 flex items-center justify-between gap-3 border-t border-border bg-canvas/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:bottom-0 lg:mx-0 lg:rounded-t-lg lg:px-0">
            <SubmitHint action="create" />
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" href={props.cancelHref ?? "/workspace/my"} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Create job
              </Button>
            </div>
          </div>
        </form>

        <aside aria-label="Job preview" className="hidden xl:block">
          <div className="sticky top-20 flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-xs">
            <div>
              <p className="eyebrow">Preview</p>
              <p className="mt-1 text-md font-semibold leading-6 text-ink break-words">{name.trim() || <span className="text-ink-subtle">Untitled job</span>}</p>
              <p className="mt-0.5 truncate text-sm text-ink-muted">
                {clientProject.client ? clientProject.client.name : "No client"}
                {clientProject.project ? ` / ${clientProject.project.name}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <CategoryPill category={startsAs} size="sm" label={startsAs === "assigned" ? "Starts as Assigned" : "Starts as New"} />
              <PriorityPill priority={priority} />
              {dates.dueDate ? <DueChip due={endOfCivilDayIso(dates.dueDate, timeZone)} timeZone={timeZone} /> : null}
            </div>
            <dl className="flex flex-col gap-2.5 border-t border-border pt-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Photographer</dt>
                <dd className="min-w-0">
                  <PersonChip user={selectedPhotographer} size="xs" emptyLabel="None yet" />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Editor</dt>
                <dd className="min-w-0">
                  <PersonChip user={previewEditor} size="xs" emptyLabel="Assign later" />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Workflow</dt>
                <dd className="truncate text-ink">{jobType?.workflow.name ?? "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-ink-muted">Links</dt>
                <dd className="numeric text-ink">{filledLinks(links).length}</dd>
              </div>
            </dl>
            <p className="border-t border-border pt-4 text-xs text-ink-subtle">
              Everything you set here is recorded in the job&apos;s history. The job number is assigned when you create it.
            </p>
          </div>
        </aside>
      </div>
      {clientProject.dialogs}
    </>
  );
}

