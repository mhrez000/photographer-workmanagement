"use client";

import * as React from "react";
import { Building2, FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import type { Client, ClientOption, Project, ProjectOption } from "@/lib/types";
import { firstFieldErrors } from "@/components/jobs";

interface QuickDialogBase<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills the name (what the user typed in the search box). */
  initialName?: string;
  onCreated: (option: T) => void;
}

/** Shared submit plumbing: POST, map field errors, toast the rest. */
function useQuickSubmit() {
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const submit = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setErrors({});
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation" && Object.keys(err.fieldErrors).length > 0) {
        setErrors(firstFieldErrors(err.fieldErrors));
      } else {
        toast.error(errorMessage(err));
      }
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, errors, setErrors, submit };
}

/** "+ New client" from the create-job form: name + optional contact, POST /api/clients. */
export function NewClientDialog({ open, onOpenChange, initialName = "", onCreated }: QuickDialogBase<ClientOption>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      {open ? <NewClientForm initialName={initialName} onOpenChange={onOpenChange} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function NewClientForm({ initialName, onOpenChange, onCreated }: Omit<QuickDialogBase<ClientOption>, "open">) {
  const [name, setName] = React.useState(initialName ?? "");
  const [contactName, setContactName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const { busy, errors, setErrors, submit } = useQuickSubmit();

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!name.trim()) {
      setErrors({ name: "Give the client a name" });
      return;
    }
    const client = await submit(() =>
      api.post<Client>("/api/clients", {
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      }),
    );
    if (!client) return;
    toast.success(`Client "${client.name}" created`);
    onCreated({ id: client.id, name: client.name, colour: client.colour });
    onOpenChange(false);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="contents">
      <DialogHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <Building2 aria-hidden="true" className="size-5" />
        </div>
        <DialogTitle>New client</DialogTitle>
        <DialogDescription>Agencies, couples, brands — whoever the work is for. Add more detail later from Clients.</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4 pb-5">
        <FormField label="Client name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. ABC Real Estate" maxLength={200} />
        </FormField>
        <FormField label="Contact name" optional error={errors.contactName}>
          <Input value={contactName} onChange={(e) => setContactName(e.target.value)} autoComplete="off" maxLength={200} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Email" optional error={errors.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" inputMode="email" />
          </FormField>
          <FormField label="Phone" optional error={errors.phone}>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" inputMode="tel" maxLength={50} />
          </FormField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Create client
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "+ New project" for the chosen client: name + address, POST /api/projects. */
export function NewProjectDialog({
  open,
  onOpenChange,
  initialName = "",
  client,
  onCreated,
}: QuickDialogBase<ProjectOption> & { client: { id: string; name: string } | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      {open && client ? <NewProjectForm initialName={initialName} client={client} onOpenChange={onOpenChange} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function NewProjectForm({
  initialName,
  client,
  onOpenChange,
  onCreated,
}: Omit<QuickDialogBase<ProjectOption>, "open"> & { client: { id: string; name: string } }) {
  const [name, setName] = React.useState(initialName ?? "");
  const [address, setAddress] = React.useState("");
  const { busy, errors, setErrors, submit } = useQuickSubmit();

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!name.trim()) {
      setErrors({ name: "Give the project a name" });
      return;
    }
    const project = await submit(() =>
      api.post<Project>("/api/projects", { clientId: client.id, name: name.trim(), address: address.trim() || undefined }),
    );
    if (!project) return;
    toast.success(`Project "${project.name}" created`);
    onCreated({ id: project.id, name: project.name, clientId: project.clientId, clientName: client.name });
    onOpenChange(false);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="contents">
      <DialogHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
          <FolderPlus aria-hidden="true" className="size-5" />
        </div>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          For <strong className="font-medium text-ink">{client.name}</strong> — usually a property, event or campaign.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4 pb-5">
        <FormField label="Project name" required error={errors.name ?? errors.clientId}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. 123 Smith Street" maxLength={200} />
        </FormField>
        <FormField label="Address" optional error={errors.address}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" maxLength={500} />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}
