"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil } from "lucide-react";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api-client";
import { AVATAR_PALETTE } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface ClientFormValues {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  notes: string;
  colour: string;
}

export const EMPTY_CLIENT: ClientFormValues = { name: "", contactName: "", email: "", phone: "", notes: "", colour: AVATAR_PALETTE[1] };

type Errors = Partial<Record<keyof ClientFormValues | "form", string>>;

function toErrors(err: ApiError): Errors {
  const out: Errors = {};
  for (const [k, v] of Object.entries(err.fieldErrors)) if (v?.[0]) out[k as keyof ClientFormValues] = v[0];
  if (Object.keys(out).length === 0) out.form = err.message;
  return out;
}

function ColourPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Client colour" className="flex flex-wrap gap-2">
      {AVATAR_PALETTE.map((c) => {
        const on = c.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c}
            onClick={() => onChange(c)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow focus-ring",
              on && "ring-2 ring-ink",
            )}
            style={{ backgroundColor: c }}
          >
            {on ? <Check aria-hidden="true" className="size-3.5 text-white" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The client fields (shared by the create page and the edit dialog). */
export function ClientFields({
  values,
  onChange,
  errors,
  showNotes = true,
}: {
  values: ClientFormValues;
  onChange: (patch: Partial<ClientFormValues>) => void;
  errors: Errors;
  showNotes?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Client name" required error={errors.name} description="The agency, brand or person you shoot for.">
        <Input value={values.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="ABC Real Estate" autoComplete="organization" maxLength={200} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Contact name" optional error={errors.contactName}>
          <Input value={values.contactName} onChange={(e) => onChange({ contactName: e.target.value })} placeholder="Sarah Nguyen" autoComplete="name" maxLength={200} />
        </FormField>
        <FormField label="Phone" optional error={errors.phone}>
          <Input value={values.phone} onChange={(e) => onChange({ phone: e.target.value })} placeholder="02 9000 0000" type="tel" autoComplete="tel" maxLength={50} />
        </FormField>
      </div>
      <FormField label="Email" optional error={errors.email}>
        <Input value={values.email} onChange={(e) => onChange({ email: e.target.value })} placeholder="bookings@abcrealestate.com.au" type="email" autoComplete="email" maxLength={254} />
      </FormField>
      <FormField label="Colour" optional error={errors.colour} description="Used on calendars and boards to tell clients apart at a glance.">
        {() => <ColourPicker value={values.colour} onChange={(colour) => onChange({ colour })} />}
      </FormField>
      {showNotes ? (
        <FormField label="Notes" optional error={errors.notes} description="Preferences, access instructions, billing details. Visible to the owner, admins and photographers — never to editors or the client.">
          <Textarea value={values.notes} onChange={(e) => onChange({ notes: e.target.value })} rows={4} maxLength={5000} />
        </FormField>
      ) : null}
    </div>
  );
}

function payload(v: ClientFormValues) {
  return {
    name: v.name.trim(),
    contactName: v.contactName.trim() || null,
    email: v.email.trim() || null,
    phone: v.phone.trim() || null,
    notes: v.notes.trim() || null,
    colour: v.colour,
  };
}

/** `/clients/new` form: POST /api/clients, then open the new client. */
export function NewClientForm({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const [values, setValues] = React.useState<ClientFormValues>(EMPTY_CLIENT);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) {
      setErrors({ name: "Give the client a name" });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const client = await api.post<{ id: string; name: string }>("/api/clients", payload(values));
      toast.success(`Client “${client.name}” created`);
      router.push(returnTo ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}clientId=${client.id}` : `/clients/${client.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setErrors(toErrors(err));
      else toast.error("Couldn't create the client", errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <ClientFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} />
      {errors.form ? <p className="text-sm text-danger">{errors.form}</p> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Create client
        </Button>
      </div>
    </form>
  );
}

export interface EditClientDialogProps {
  client: { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; colour: string; version: number };
  notes: string | null;
  /** False for roles that cannot read notes (editing would blank them otherwise). */
  canSeeNotes: boolean;
  timeZone: string;
}

/** "Edit" button + dialog: PATCH /api/clients/:id with expectedVersion; 409 → ConflictDialog. */
export function EditClientDialog({ client, notes, canSeeNotes, timeZone }: EditClientDialogProps) {
  const router = useRouter();
  const initial = React.useMemo<ClientFormValues>(
    () => ({
      name: client.name,
      contactName: client.contactName ?? "",
      email: client.email ?? "",
      phone: client.phone ?? "",
      notes: notes ?? "",
      colour: client.colour,
    }),
    [client, notes],
  );
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState(initial);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  const openDialog = () => {
    setValues(initial);
    setErrors({});
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) {
      setErrors({ name: "Give the client a name" });
      return;
    }
    setSaving(true);
    setErrors({});
    const body: Record<string, unknown> = { expectedVersion: client.version, ...payload(values) };
    if (!canSeeNotes) delete body.notes;
    try {
      await api.patch(`/api/clients/${client.id}`, body);
      toast.success("Client updated");
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.isConflict) {
        setOpen(false);
        setConflict(err);
      } else if (err instanceof ApiError && err.code === "validation") {
        setErrors(toErrors(err));
      } else {
        toast.error("Couldn't save the client", errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" leadingIcon={<Pencil aria-hidden="true" />} onClick={openDialog}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen} size="md">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Edit client</DialogTitle>
            <DialogDescription>Changes are recorded in the activity log with the previous values.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ClientFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} showNotes={canSeeNotes} />
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
        entity="client"
        timeZone={timeZone}
        onReload={() => {
          setConflict(null);
          router.refresh();
        }}
      />
    </>
  );
}
