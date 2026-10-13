"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiError, api, errorMessage } from "@/lib/api-client";
import { AVATAR_PALETTE } from "@/lib/constants";

export interface ClientFormValues {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  notes: string;
}

export const EMPTY_CLIENT: ClientFormValues = { name: "", contactName: "", email: "", phone: "", notes: "" };

type Errors = Partial<Record<keyof ClientFormValues | "form", string>>;

function toErrors(err: ApiError): Errors {
  const out: Errors = {};
  for (const [k, v] of Object.entries(err.fieldErrors)) if (v?.[0]) out[k as keyof ClientFormValues] = v[0];
  if (Object.keys(out).length === 0) out.form = err.message;
  return out;
}

/** A stable palette colour for a new client (the simple UI has no colour picker; the colour stays editable under Advanced). */
export function clientColourFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * The client fields (plan §3 "Clients": name, contact, open jobs, late): a name, the person you deal with,
 * and private notes. Shared by the New client dialog / page and the Edit dialog.
 */
export function ClientFields({
  values,
  onChange,
  errors,
  showNotes = true,
  autoFocus = false,
}: {
  values: ClientFormValues;
  onChange: (patch: Partial<ClientFormValues>) => void;
  errors: Errors;
  showNotes?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Client name" required error={errors.name} description="The agency, business or person you shoot for.">
        <Input value={values.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Harbourline Realty" autoComplete="organization" maxLength={200} autoFocus={autoFocus} />
      </FormField>
      <FormField label="Contact" optional error={errors.contactName} description="Who you deal with there.">
        <Input value={values.contactName} onChange={(e) => onChange({ contactName: e.target.value })} placeholder="e.g. Sarah Kingsley" autoComplete="name" maxLength={200} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Email" optional error={errors.email}>
          <Input value={values.email} onChange={(e) => onChange({ email: e.target.value })} placeholder="bookings@…" type="email" autoComplete="email" maxLength={254} inputMode="email" />
        </FormField>
        <FormField label="Phone" optional error={errors.phone}>
          <Input value={values.phone} onChange={(e) => onChange({ phone: e.target.value })} placeholder="04…" type="tel" autoComplete="tel" maxLength={50} inputMode="tel" />
        </FormField>
      </div>
      {showNotes ? (
        <FormField label="Private notes" optional error={errors.notes} description="Access codes, how they like things, billing. Only you and your photographers see this — never editors or the client.">
          <Textarea value={values.notes} onChange={(e) => onChange({ notes: e.target.value })} rows={3} maxLength={5000} />
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
  };
}

/** `/clients/new` page form: POST /api/clients, then open the new client (or return to `returnTo`). */
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
      const client = await api.post<{ id: string; name: string }>("/api/clients", { ...payload(values), colour: clientColourFor(values.name.trim()) });
      toast.success(`${client.name} added`);
      router.push(returnTo ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}clientId=${client.id}` : `/clients/${client.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setErrors(toErrors(err));
      else toast.error("Couldn't add the client", errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <ClientFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} autoFocus />
      {errors.form ? <p className="text-sm text-danger">{errors.form}</p> : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Add client
        </Button>
      </div>
    </form>
  );
}

/** "New client" button + dialog on the Clients list: POST /api/clients, then open the new client. */
export function NewClientDialog({ size = "md" }: { size?: "sm" | "md" }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [values, setValues] = React.useState<ClientFormValues>(EMPTY_CLIENT);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);

  const openDialog = () => {
    setValues(EMPTY_CLIENT);
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
    try {
      const client = await api.post<{ id: string; name: string }>("/api/clients", { ...payload(values), colour: clientColourFor(values.name.trim()) });
      toast.success(`${client.name} added`);
      setOpen(false);
      router.push(`/clients/${client.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setErrors(toErrors(err));
      else toast.error("Couldn't add the client", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button size={size} leadingIcon={<Plus aria-hidden="true" />} onClick={openDialog}>
        New client
      </Button>
      <Dialog open={open} onOpenChange={(o) => (saving ? undefined : setOpen(o))} size="md">
        {open ? (
          <form onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>New client</DialogTitle>
              <DialogDescription>Just a name is enough. You can add contact details later.</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <ClientFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={errors} autoFocus />
              {errors.form ? <p className="mt-3 text-sm text-danger">{errors.form}</p> : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Add client
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

export interface EditClientDialogProps {
  client: { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; version: number };
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
            <DialogDescription>Every change is kept in the history.</DialogDescription>
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
              Save
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
