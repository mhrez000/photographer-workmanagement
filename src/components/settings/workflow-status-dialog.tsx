"use client";

import * as React from "react";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import { STATUS_CATEGORIES, STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { WorkflowStatusView } from "@/lib/types";
import { slugify } from "@/lib/utils";
import { CATEGORY_MEANING } from "./category-meaning";
import { ColourField } from "./colour-field";

const STATUS_PALETTE = Array.from(new Set(STATUS_CATEGORIES.map((c) => STATUS_CATEGORY_META[c].hex)));

export interface StatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  /** null = add a new status. */
  status: WorkflowStatusView | null;
  readOnly: boolean;
  onConflict: (err: ApiError) => void;
}

/** Add or edit one workflow status. */
export function StatusDialog({ open, onOpenChange, workflowId, status, readOnly, onConflict }: StatusDialogProps) {
  const run = useMutationRunner();
  const [name, setName] = React.useState(status?.name ?? "");
  const [key, setKey] = React.useState(status?.key ?? "");
  const [keyTouched, setKeyTouched] = React.useState(false);
  const [category, setCategory] = React.useState<StatusCategory>(status?.category ?? "in_progress");
  const [colour, setColour] = React.useState(status?.colour ?? STATUS_CATEGORY_META.in_progress.hex);
  const [colourTouched, setColourTouched] = React.useState(Boolean(status));
  const [description, setDescription] = React.useState(status?.description ?? "");
  const [isInitial, setIsInitial] = React.useState(status?.isInitial ?? false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);

  const recategorising = status !== null && category !== status.category && status.jobCount > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    setErrors({});
    setPending(true);
    const res = status
      ? await run(
          () => {
            const body: Record<string, unknown> = { expectedVersion: status.version };
            if (name.trim() !== status.name) body.name = name.trim();
            if (category !== status.category) body.category = category;
            if (colour !== status.colour) body.colour = colour;
            if ((description.trim() || null) !== status.description) body.description = description.trim() || null;
            if (isInitial && !status.isInitial) body.isInitial = true;
            return api.patch(`/api/statuses/${status.id}`, body);
          },
          {
            success: "Status updated",
            onConflict: (err) => {
              onOpenChange(false);
              onConflict(err);
            },
          },
        )
      : await run(
          () =>
            api.post(`/api/workflows/${workflowId}/statuses`, {
              name: name.trim(),
              key: key.trim() || undefined,
              category,
              colour,
              description: description.trim() || null,
              isInitial: isInitial || undefined,
            }),
          { success: `Status “${name.trim()}” added` },
        );
    setPending(false);
    if (res.ok) onOpenChange(false);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))} size="md">
      <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle>{status ? (readOnly ? status.name : `Edit ${status.name}`) : "Add a status"}</DialogTitle>
          <DialogDescription>The name is what people see; the category is what reports, boards and automations understand.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" required error={errors.name}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!status && !keyTouched) setKey(slugify(e.target.value).replaceAll("-", "_").replace(/^[^a-z]+/, ""));
                }}
                disabled={readOnly}
                autoFocus={!readOnly}
                maxLength={80}
              />
            </FormField>
            <FormField
              label="Key"
              description={status ? "Stable id used by automations; never changes." : "Lowercase slug. Generated from the name."}
              error={errors.key}
            >
              <Input
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyTouched(true);
                }}
                disabled={readOnly || status !== null}
                mono
                maxLength={64}
              />
            </FormField>
          </div>
          <FormField label="Category" description={CATEGORY_MEANING[category]} error={errors.category}>
            <Select
              value={category}
              onChange={(e) => {
                const next = e.target.value as StatusCategory;
                setCategory(next);
                if (!colourTouched) setColour(STATUS_CATEGORY_META[next].hex);
                if (next !== "new") setIsInitial(false);
              }}
              disabled={readOnly}
            >
              {STATUS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {STATUS_CATEGORY_META[c].label}
                </option>
              ))}
            </Select>
          </FormField>
          {recategorising ? (
            <p className="rounded-md bg-attention-soft px-3 py-2 text-sm text-attention-fg">
              {status?.jobCount} {status?.jobCount === 1 ? "job is" : "jobs are"} in this status. Their category changes with it; history keeps the old snapshot.
            </p>
          ) : null}
          <FormField label="Colour" error={errors.colour}>
            <ColourField
              value={colour}
              onChange={(c) => {
                setColour(c);
                setColourTouched(true);
              }}
              palette={STATUS_PALETTE}
              disabled={readOnly}
              label="Status colour"
            />
          </FormField>
          <FormField label="Description" optional error={errors.description}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} disabled={readOnly} />
          </FormField>
          {category === "new" ? (
            <Checkbox
              checked={isInitial}
              onChange={(e) => setIsInitial(e.target.checked)}
              disabled={readOnly || Boolean(status?.isInitial)}
              label="Initial status"
              description={status?.isInitial ? "New jobs start here. Make another “new” status initial to change it." : "New jobs start here (replaces the current initial status)."}
            />
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly ? (
            <Button type="submit" loading={pending}>
              {status ? "Save status" : "Add status"}
            </Button>
          ) : null}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
