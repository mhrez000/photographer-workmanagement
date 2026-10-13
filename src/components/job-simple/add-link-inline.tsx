"use client";

import * as React from "react";
import { Link2, Plus } from "lucide-react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { LINK_KIND_META, type LinkKind } from "@/lib/constants";
import { isAllowedLinkUrl } from "@/lib/validation/links";

export interface AddLinkInlineProps {
  jobId: string;
  /** Kinds the viewer may add here; one kind = no picker. */
  kinds: readonly LinkKind[];
  /** Button text ("Add raw files link"). */
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/** A small "Add link" button that unfolds into URL (+ optional name) and posts to `/api/jobs/:id/links`. */
export function AddLinkInline({ jobId, kinds, label, size = "sm", className }: AddLinkInlineProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<LinkKind>(kinds[0] ?? "other");
  const [url, setUrl] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  if (kinds.length === 0) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!isAllowedLinkUrl(trimmed)) {
      setError("Paste a full link starting with https://");
      return;
    }
    setBusy(true);
    const result = await run(() => api.post(`/api/jobs/${jobId}/links`, { kind, url: trimmed, label: name.trim() || null }), { success: "Link added" });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setUrl("");
      setName("");
      setError(null);
    } else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setError(f.url ?? Object.values(f)[0] ?? "Please check the link.");
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size={size} leadingIcon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)} className={className}>
        {label}
      </Button>
    );
  }

  return (
    <form onSubmit={submit} noValidate className={className}>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken/60 p-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <FormField label="Link" required error={error ?? undefined}>
            <Input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              placeholder="https://"
              leading={<Link2 aria-hidden="true" />}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          {kinds.length > 1 ? (
            <FormField label="What is it?">
              <Select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} options={kinds.map((k) => ({ value: k, label: LINK_KIND_META[k].label }))} wrapperClassName="sm:w-44" />
            </FormField>
          ) : null}
        </div>
        <FormField label="Name" optional>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={kinds.length > 1 ? "e.g. Floor plan" : undefined} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={busy}>
            Add link
          </Button>
        </div>
      </div>
    </form>
  );
}
