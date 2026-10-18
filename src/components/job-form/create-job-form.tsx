"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Lock } from "lucide-react";
import { LinkProviderIcon, jobHref } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { AVATAR_PALETTE, DEFAULT_USUAL_DAYS_TO_EDIT, SIMPLE_LINK_SLOTS, priorityForRush, type Role } from "@/lib/constants";
import { addCivilDays } from "@/lib/dates";
import type { Client, ClientOption, EditorPickerOption, Job, JobTypeView, UserOption } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { deriveLinkProvider, isAllowedLinkUrl } from "@/lib/validation/links";
import { ClientPicker, type ClientChoice } from "./client-picker";
import { EditorPicker } from "./editor-picker";
import { fromCivilInput, pickErrors } from "./form-utils";
import { LinksEditor, draftLinkError, filledLinks, type DraftLink } from "./links-editor";
import { PersonPicker } from "./person-picker";
import { SubmitHint, formKeyDown, useUnsavedChangesWarning } from "./submit-hint";

export interface CreateJobFormProps {
  viewer: { id: string; name: string; role: Role; avatarColour: string; isAdmin?: boolean };
  timeZone: string;
  /** Today's civil date in the studio timezone (the shoot date default). */
  today: string;
  jobTypes: JobTypeView[];
  /** "Usual days to edit" per job type id (null → DEFAULT_USUAL_DAYS_TO_EDIT). */
  usualDays: Record<string, number | null>;
  /** The last type of shoot this person used (plan §5), when it still exists. */
  defaultJobTypeId: string | null;
  clients: ClientOption[];
  initialClientId: string | null;
  /** Pre-filled address (e.g. from a project page while Advanced tools is on). */
  initialAddress?: string;
  /** Pre-selected editor (from an editor page's "Give them a job", plan §7); must be one of `editors`. */
  initialEditorId?: string | null;
  canCreateClient: boolean;
  /**
   * Photographer field (docs/ROLES.md §4, plan §5 "Photographer (only if the studio has more than one)"):
   * - "pick": owners choose; shown under More options only when `photographers.length > 1`;
   * - "self": extra photographers are always the photographer on jobs they create (no field);
   * - "required": editors must say who shot it (pre-filled with the owner / studio default).
   */
  photographerMode: "pick" | "self" | "required";
  /** Active photographers of the studio (empty for "self"). */
  photographers: UserOption[];
  defaultPhotographerId: string | null;
  /** Editor field: "pick" (owners, photographers with Assign editors), "self" (editors), "none" (hidden). */
  editorMode: "pick" | "self" | "none";
  /** Picker rows with "On their desk N · Late N" (empty unless editorMode is "pick"). */
  editors: EditorPickerOption[];
  /** Where Cancel goes. */
  cancelHref: string;
}

interface CreatedJob {
  job: Job;
}

/** Field order used to focus the first invalid control after a failed submit. */
const FIELD_ORDER = ["client", "name", "jobTypeId", "shootDate", "dueDate", "editorId", "photographerId", "rawUrl", "instructions", "deliveryDueDate", "links"];

/** Due date default (plan §5): shoot date + that type's usual days to edit. */
export function defaultDueFor(shootDate: string, jobTypeId: string, usualDays: Record<string, number | null>): string {
  if (!shootDate) return "";
  return addCivilDays(shootDate, usualDays[jobTypeId] ?? DEFAULT_USUAL_DAYS_TO_EDIT);
}

/** A stable palette colour for a client created from the form (no colour picker in the simple UI). */
export function colourForName(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * The New job form (docs/SIMPLIFICATION-PLAN.md §5): one screen, 8 fields, a collapsed "More options".
 * POST /api/clients (only when a new name was typed) → POST /api/jobs with `autoProject` (the project is
 * reused or created from the address behind the scenes) → the raw files link and any other links →
 * open the job. ⌘/Ctrl+Enter submits.
 */
export function CreateJobForm(props: CreateJobFormProps) {
  const { viewer, today, jobTypes, usualDays, photographerMode, editorMode, photographers, editors } = props;
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const isEditorCreator = editorMode === "self";
  const canPickEditor = editorMode === "pick";
  const showPhotographer = photographerMode === "required" || (photographerMode === "pick" && photographers.length > 1);
  const initialType = props.defaultJobTypeId && jobTypes.some((t) => t.id === props.defaultJobTypeId) ? props.defaultJobTypeId : (jobTypes[0]?.id ?? "");

  const [client, setClient] = React.useState<ClientChoice>(props.initialClientId ? { kind: "existing", id: props.initialClientId } : null);
  const [name, setName] = React.useState(props.initialAddress ?? "");
  const [jobTypeId, setJobTypeId] = React.useState(initialType);
  const [shootDate, setShootDate] = React.useState(today);
  const [dueDate, setDueDate] = React.useState(() => defaultDueFor(today, initialType, usualDays));
  const [dueTouched, setDueTouched] = React.useState(false);
  const [editorId, setEditorId] = React.useState<string | null>(
    canPickEditor && props.initialEditorId && editors.some((e) => e.editor.id === props.initialEditorId) ? props.initialEditorId : null,
  );
  const [selfAssign, setSelfAssign] = React.useState<"me" | "unassigned">("me");
  const [photographerId, setPhotographerId] = React.useState<string | null>(photographerMode === "self" ? viewer.id : props.defaultPhotographerId);
  const [rawUrl, setRawUrl] = React.useState("");
  const [rawTouched, setRawTouched] = React.useState(false);
  const [instructions, setInstructions] = React.useState("");
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [rush, setRush] = React.useState(false);
  const [deliveryDueDate, setDeliveryDueDate] = React.useState("");
  const [otherLinks, setOtherLinks] = React.useState<DraftLink[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const moreId = React.useId();
  const jobType = jobTypes.find((t) => t.id === jobTypeId) ?? null;
  const usual = usualDays[jobTypeId] ?? DEFAULT_USUAL_DAYS_TO_EDIT;
  const chosenEditor = canPickEditor ? (editors.find((e) => e.editor.id === editorId) ?? null) : null;
  const chosenPhotographer = photographers.find((p) => p.id === photographerId) ?? null;
  const rawTrimmed = rawUrl.trim();
  const rawProvider = rawTrimmed && isAllowedLinkUrl(rawTrimmed) ? deriveLinkProvider(rawTrimmed) : null;
  const rawError = rawTrimmed && !isAllowedLinkUrl(rawTrimmed) ? "Enter a full http:// or https:// link" : null;

  const dirty = !done && Boolean(client || name.trim() || instructions.trim() || rawTrimmed || editorId || filledLinks(otherLinks).length > 0);
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
    if (!dueTouched) setDueDate(defaultDueFor(shootDate, id, usualDays));
  };
  const onShootDateChange = (value: string) => {
    setShootDate(value);
    clearError("shootDate");
    if (!dueTouched) setDueDate(defaultDueFor(value, jobTypeId, usualDays));
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!client) e.client = props.canCreateClient ? "Pick a client, or type a new name" : "Pick the client";
    if (!name.trim()) e.name = "Type the address or a short job name";
    if (!jobTypeId) e.jobTypeId = "Choose the type of shoot";
    if (photographerMode === "required" && !photographerId) e.photographerId = "Choose who shot it";
    if (rawError) e.rawUrl = rawError;
    if (otherLinks.some((l) => draftLinkError(l))) e.links = "Fix the highlighted links";
    if (shootDate && dueDate && dueDate < shootDate) e.dueDate = "The due date is before the shoot";
    return e;
  };

  const focusFirstError = (errs: Record<string, string>) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (!first) return;
    if (["deliveryDueDate", "links", "photographerId"].includes(first) && !moreOpen && !(first === "photographerId" && photographerMode === "required")) setMoreOpen(true);
    requestAnimationFrame(() => {
      const root = formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
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
    if (Object.keys(local).length > 0 || !client) {
      focusFirstError(local);
      return;
    }

    setBusy(true);
    const address = name.trim();
    let clientId: string;
    let created: CreatedJob;
    try {
      if (client.kind === "new") {
        const row = await api.post<Client>("/api/clients", { name: client.name, colour: colourForName(client.name) });
        clientId = row.id;
        setClient({ kind: "existing", id: row.id });
      } else {
        clientId = client.id;
      }
      created = await api.post<CreatedJob>("/api/jobs", {
        name: address,
        description: instructions.trim() || undefined,
        autoProject: { clientId, address },
        jobTypeId,
        priority: priorityForRush(rush),
        photographerId: photographerMode === "self" ? undefined : (photographerId ?? undefined),
        editorId: isEditorCreator ? (selfAssign === "me" ? viewer.id : undefined) : canPickEditor && editorId ? editorId : undefined,
        shootDate: fromCivilInput(shootDate) ?? undefined,
        dueDate: fromCivilInput(dueDate),
        deliveryDueDate: fromCivilInput(deliveryDueDate) ?? undefined,
      });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "validation" && Object.keys(err.fieldErrors).length > 0) {
        const server = pickErrors(err.fieldErrors);
        // The API speaks in its own field names; map the ones the form shows.
        if (server.clientId) server.client = server.clientId;
        if (server.autoProject) server.name = server.autoProject;
        setErrors(server);
        focusFirstError(server);
        toast.error("Check the highlighted fields", err.message !== "Validation failed" ? err.message : undefined);
      } else {
        toast.error("The job was not created", errorMessage(err));
      }
      return;
    }

    // Links against the new job. A failure here never loses the job.
    const jobId = created.job.id;
    const failures: string[] = [];
    const links: { kind: DraftLink["kind"]; url: string; label?: string }[] = [];
    if (rawTrimmed) links.push({ kind: "raw_files", url: rawTrimmed });
    for (const l of filledLinks(otherLinks)) links.push({ kind: l.kind, url: l.url.trim(), label: l.label.trim() || undefined });
    for (const link of links) {
      try {
        await api.post(`/api/jobs/${jobId}/links`, link);
      } catch (err) {
        failures.push(`${link.kind === "raw_files" ? "raw files link" : "link"} (${errorMessage(err)})`);
      }
    }

    setDone(true);
    const sentTo = chosenEditor ? ` · sent to ${chosenEditor.editor.name}` : isEditorCreator && selfAssign === "me" ? " · it's on your desk" : "";
    if (failures.length > 0) {
      toast.warning(`${created.job.jobNumber} created — ${pluralise(failures.length, "link")} not saved`, `Add again from the job: ${failures.join("; ")}`);
    } else {
      toast.success(`${created.job.jobNumber} created${sentTo}`, created.job.name);
    }
    router.push(jobHref(jobId));
    router.refresh();
  };

  const showErr = (key: string) => (submitted || key in errors ? errors[key] : undefined);
  const submitLabel = chosenEditor ? `Create & send to ${chosenEditor.editor.name}` : isEditorCreator && selfAssign === "me" ? "Create & assign to me" : "Create job";
  const moreCount = [rush, Boolean(deliveryDueDate), filledLinks(otherLinks).length > 0, showPhotographer && photographerMode === "pick" && photographerId !== props.defaultPhotographerId].filter(Boolean).length;

  return (
    <form ref={formRef} onSubmit={onSubmit} onKeyDown={formKeyDown} noValidate aria-label="Create job" className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div data-field="client">
        <FormField label="Client" required error={showErr("client")} description={client?.kind === "new" ? `“${client.name}” is added as a new client when you create the job.` : undefined}>
          {(control) => (
            <ClientPicker
              {...control}
              clients={props.clients}
              value={client}
              onChange={(next) => {
                setClient(next);
                clearError("client");
              }}
              canCreate={props.canCreateClient}
              disabled={busy}
              autoFocus
            />
          )}
        </FormField>
      </div>

      <div data-field="name">
        <FormField label="Address / job name" required error={showErr("name")}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearError("name");
            }}
            placeholder="e.g. 8 Penrose St, Bondi"
            maxLength={200}
            disabled={busy}
            autoComplete="off"
          />
        </FormField>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div data-field="jobTypeId">
          <FormField label="Type of shoot" required error={showErr("jobTypeId")}>
            <Select value={jobTypeId} onChange={(e) => onJobTypeChange(e.target.value)} placeholder="Choose a type" disabled={busy || jobTypes.length === 0} required>
              {jobTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <div data-field="shootDate">
          <FormField label="Shoot date" error={showErr("shootDate")}>
            <DateInput value={shootDate} onChange={(e) => onShootDateChange(e.target.value)} disabled={busy} />
          </FormField>
        </div>
        <div data-field="dueDate">
          <FormField
            label="Due date"
            error={showErr("dueDate")}
            description={!dueTouched && jobType ? `${pluralise(usual, "day")} after the shoot, as usual for ${jobType.name}.` : undefined}
          >
            <DateInput
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value);
                setDueTouched(true);
                clearError("dueDate");
              }}
              disabled={busy}
            />
          </FormField>
        </div>
      </div>

      {canPickEditor ? (
        <div data-field="editorId">
          <FormField
            label="Editor"
            optional
            error={showErr("editorId")}
            description={chosenEditor ? `${chosenEditor.editor.name} gets it as soon as you create the job.` : "Decide later and the job waits in Needs editor."}
          >
            {(control) => (
              <EditorPicker
                {...control}
                editors={editors}
                value={editorId}
                onChange={(id) => {
                  setEditorId(id);
                  clearError("editorId");
                }}
                disabled={busy}
              />
            )}
          </FormField>
        </div>
      ) : isEditorCreator ? (
        <div data-field="editorId">
          <FormField label="Editor" error={showErr("editorId")} description={selfAssign === "me" ? "It lands on your desk straight away." : "It waits in Needs editor until the studio hands it out."}>
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
      ) : null}

      {photographerMode === "required" ? (
        <div data-field="photographerId">
          <FormField label="Shot by" required error={showErr("photographerId")} description="They check your edit when you send it.">
            {(control) =>
              photographers.length > 1 ? (
                <PersonPicker
                  {...control}
                  kind="photographer"
                  people={photographers}
                  value={photographerId}
                  onChange={(id) => {
                    setPhotographerId(id);
                    clearError("photographerId");
                  }}
                  disabled={busy}
                />
              ) : (
                <LockedPerson id={control.id} name={chosenPhotographer?.name ?? viewer.name} colour={chosenPhotographer?.avatarColour} />
              )
            }
          </FormField>
        </div>
      ) : null}

      <div data-field="rawUrl">
        <FormField label="Raw files link" optional error={showErr("rawUrl") ?? (rawTouched ? rawError : null)} description="Where the editor finds the photos — Dropbox, Drive, WeTransfer, a shared folder.">
          <Input
            type="url"
            inputMode="url"
            value={rawUrl}
            onChange={(e) => {
              setRawUrl(e.target.value);
              clearError("rawUrl");
            }}
            onBlur={() => setRawTouched(true)}
            placeholder="https://"
            leading={<LinkProviderIcon provider={rawProvider ?? "other"} url={rawTrimmed || null} />}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>

      <div data-field="instructions">
        <FormField label="Instructions for the editor" optional description="Style, what to prioritise, anything unusual. The editor sees this on the job.">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={5000} disabled={busy} placeholder="e.g. Bright and airy, replace the sky on the front shots, 25 photos max." />
        </FormField>
      </div>

      <div className="rounded-lg border border-border">
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          onClick={() => setMoreOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium text-ink hover:bg-surface-muted focus-ring"
        >
          <span>
            More options
            {!moreOpen && moreCount > 0 ? <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-ink">{moreCount} set</span> : null}
          </span>
          <ChevronDown aria-hidden="true" className={cn("size-4 text-ink-subtle transition-transform duration-(--motion-fast)", moreOpen && "rotate-180")} />
        </button>
        <div id={moreId} hidden={!moreOpen} className="flex flex-col gap-5 border-t border-border px-4 pb-5 pt-4">
          <Checkbox label="Rush job" description="Shows a red Rush badge and sorts it to the top." checked={rush} onChange={(e) => setRush(e.target.checked)} disabled={busy} />

          {showPhotographer && photographerMode === "pick" ? (
            <div data-field="photographerId" className="sm:max-w-sm">
              <FormField label="Photographer" error={showErr("photographerId")} description="Who shot it. They check the edits on their own shoots.">
                {(control) => (
                  <PersonPicker
                    {...control}
                    kind="photographer"
                    people={photographers}
                    value={photographerId}
                    onChange={(id) => {
                      setPhotographerId(id);
                      clearError("photographerId");
                    }}
                    clearLabel="No photographer yet"
                    disabled={busy}
                  />
                )}
              </FormField>
            </div>
          ) : null}

          <div data-field="deliveryDueDate" className="sm:max-w-xs">
            <FormField label="Client delivery date" optional error={showErr("deliveryDueDate")} description="Shown to the client when they use the portal.">
              <DateInput
                value={deliveryDueDate}
                onChange={(e) => {
                  setDeliveryDueDate(e.target.value);
                  clearError("deliveryDueDate");
                }}
                disabled={busy}
              />
            </FormField>
          </div>

          <div data-field="links" className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Other links</span>
            <p className="text-sm text-ink-muted">Floor plan, references, an editing workspace — anything that is not the raw files.</p>
            <LinksEditor
              links={otherLinks}
              kinds={SIMPLE_LINK_SLOTS.other}
              emptyText="No other links yet."
              onChange={(next) => {
                setOtherLinks(next);
                clearError("links");
              }}
              showErrors={submitted}
              disabled={busy}
            />
            {showErr("links") ? (
              <p role="alert" className="text-sm text-danger">
                {showErr("links")}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="sticky bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px))] z-(--z-page-sticky) -mx-4 mt-1 flex items-center justify-between gap-3 border-t border-border bg-canvas/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:bottom-0 lg:mx-0 lg:rounded-t-lg lg:px-0">
        <SubmitHint action="create" />
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <Button variant="ghost" href={props.cancelHref} disabled={busy} className="hidden sm:inline-flex">
            Cancel
          </Button>
          <Button type="submit" loading={busy} className="w-full sm:w-auto">
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}

function LockedPerson({ id, name, colour }: { id: string; name: string; colour?: string | null }) {
  return (
    <div id={id} className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-sm text-ink">
      <Avatar name={name} size="xs" colour={colour || undefined} />
      <span className="truncate">{name}</span>
      <Lock aria-hidden="true" className="ml-auto size-3.5 text-ink-subtle" />
    </div>
  );
}
