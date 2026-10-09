"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api-client";
import type { ClientOption } from "@/lib/types";

export interface ProjectFormValues {
  clientId: string;
  name: string;
  address: string;
  description: string;
  startDate: string;
  endDate: string;
}

type Errors = Partial<Record<keyof ProjectFormValues | "form", string>>;

function toErrors(err: ApiError): Errors {
  const out: Errors = {};
  for (const [k, v] of Object.entries(err.fieldErrors)) if (v?.[0]) out[k as keyof ProjectFormValues] = v[0];
  if (Object.keys(out).length === 0) out.form = err.message;
  return out;
}

function validate(v: ProjectFormValues): Errors {
  const e: Errors = {};
  if (!v.clientId) e.clientId = "Choose the client this project belongs to";
  if (!v.name.trim()) e.name = "Give the project a name, usually the property address";
  if (v.startDate && v.endDate && v.endDate < v.startDate) e.endDate = "The end date must be on or after the start date";
  return e;
}

export function ProjectFields({
  values,
  onChange,
  errors,
  clients,
  clientLocked = false,
  canCreateClient = false,
}: {
  values: ProjectFormValues;
  onChange: (patch: Partial<ProjectFormValues>) => void;
  errors: Errors;
  clients: ClientOption[];
  clientLocked?: boolean;
  canCreateClient?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="Client"
        required
        error={errors.clientId}
        description={clientLocked ? "A project with jobs can't move to another client." : undefined}
      >
        <Select
          value={values.clientId}
          onChange={(e) => onChange({ clientId: e.target.value })}
          placeholder="Choose a client"
          disabled={clientLocked}
          options={clients.map((c) => ({ value: c.id, label: c.name }))}
        />
      </FormField>
      {canCreateClient ? (
        <Button href="/clients/new?returnTo=/projects/new" variant="link" size="sm" className="-mt-2 self-start" leadingIcon={<Plus aria-hidden="true" />}>
          New client
        </Button>
      ) : null}
      <FormField label="Project name" required error={errors.name} description="Usually the property or shoot, e.g. “123 Smith Street”.">
        <Input value={values.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="123 Smith Street" maxLength={200} />
      </FormField>
      <FormField label="Address" optional error={errors.address}>
        <Input value={values.address} onChange={(e) => onChange({ address: e.target.value })} placeholder="123 Smith Street, Newtown NSW 2042" autoComplete="street-address" maxLength={500} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Start date" optional error={errors.startDate}>
          <DateInput value={values.startDate} max={values.endDate || undefined} onChange={(e) => onChange({ startDate: e.target.value })} />
        </FormField>
        <FormField label="End date" optional error={errors.endDate}>
          <DateInput value={values.endDate} min={values.startDate || undefined} onChange={(e) => onChange({ endDate: e.target.value })} />
        </FormField>
      </div>
      <FormField label="Notes" optional error={errors.description} description="Access details, agent preferences, anything every job here should know.">
        <Textarea value={values.description} onChange={(e) => onChange({ description: e.target.value })} rows={4} maxLength={5000} />
      </FormField>
    </div>
  );
}

function payload(v: ProjectFormValues) {
  return {
    clientId: v.clientId,
    name: v.name.trim(),
    address: v.address.trim() || null,
    description: v.description.trim() || null,
    startDate: v.startDate || null,
    endDate: v.endDate || null,
  };
}

/** `/projects/new`: POST /api/projects, then open the project. */
export function NewProjectForm({ clients, defaultClientId, canCreateClient }: { clients: ClientOption[]; defaultClientId?: string; canCreateClient?: boolean }) {
  const router = useRouter();
  const [values, setValues] = React.useState<ProjectFormValues>({
    clientId: defaultClientId && clients.some((c) => c.id === defaultClientId) ? defaultClientId : "",
    name: "",
    address: "",
    description: "",
    startDate: "",
    endDate: "",
  });
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local = validate(values);
    setErrors(local);
    if (Object.keys(local).length) return;
    setSaving(true);
    try {
      const project = await api.post<{ id: string; name: string }>("/api/projects", payload(values));
      toast.success(`Project “${project.name}” created`);
      router.push(`/projects/${project.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setErrors(toErrors(err));
      else toast.error("Couldn't create the project", errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <ProjectFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} clients={clients} canCreateClient={canCreateClient} />
      {errors.form ? <p className="text-sm text-danger">{errors.form}</p> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Create project
        </Button>
      </div>
    </form>
  );
}

export interface EditProjectDialogProps {
  project: { id: string; name: string; clientId: string; address: string | null; startDate: string | null; endDate: string | null; version: number };
  /** Civil (YYYY-MM-DD, org timezone) versions of the stored dates. */
  startCivil: string | null;
  endCivil: string | null;
  description: string | null;
  clients: ClientOption[];
  /** Jobs exist → client cannot change. */
  clientLocked: boolean;
  timeZone: string;
}

/** "Edit" button + dialog: PATCH /api/projects/:id with expectedVersion; 409 → ConflictDialog. */
export function EditProjectDialog({ project, startCivil, endCivil, description, clients, clientLocked, timeZone }: EditProjectDialogProps) {
  const router = useRouter();
  const initial = React.useMemo<ProjectFormValues>(
    () => ({
      clientId: project.clientId,
      name: project.name,
      address: project.address ?? "",
      description: description ?? "",
      startDate: startCivil ?? "",
      endDate: endCivil ?? "",
    }),
    [project, description, startCivil, endCivil],
  );
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState(initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local = validate(values);
    setErrors(local);
    if (Object.keys(local).length) return;
    setSaving(true);
    const body: Record<string, unknown> = { expectedVersion: project.version, ...payload(values) };
    if (values.clientId === project.clientId) delete body.clientId;
    // Only send dates the user actually changed: stored values are end-of-day instants.
    if (values.startDate === initial.startDate) delete body.startDate;
    if (values.endDate === initial.endDate) delete body.endDate;
    try {
      await api.patch(`/api/projects/${project.id}`, body);
      toast.success("Project updated");
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        setOpen(false);
        setConflict(err);
      } else if (err instanceof ApiError && err.code === "validation") {
        setErrors(toErrors(err));
      } else {
        toast.error("Couldn't save the project", errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        leadingIcon={<Pencil aria-hidden="true" />}
        onClick={() => {
          setValues(initial);
          setErrors({});
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen} size="md">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>Changes are recorded in the activity log with the previous values.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ProjectFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} clients={clients} clientLocked={clientLocked} />
            {errors.form ? <p className="mt-3 text-sm text-danger">{errors.form}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(o) => !o && setConflict(null)}
        error={conflict}
        entity="project"
        timeZone={timeZone}
        onReload={() => {
          setConflict(null);
          router.refresh();
        }}
      />
    </>
  );
}
