"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { WorkflowGraph } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface CreateWorkflowDialogProps {
  workflows: { id: string; name: string; isDefault: boolean }[];
  /** Pre-select "copy this workflow". */
  sourceId?: string;
  triggerLabel?: string;
  triggerVariant?: "primary" | "outline";
}

type From = "workflow" | "default" | "blank";

const FROM_OPTIONS: { value: From; title: string; description: string }[] = [
  { value: "workflow", title: "Copy a workflow", description: "Statuses and transitions of an existing workflow." },
  { value: "default", title: "Standard template", description: "The built-in 13-status photography workflow." },
  { value: "blank", title: "Minimal", description: "Only the required categories; you add the rest." },
];

/** Creates a workflow (default: clone the studio default) and opens its editor. */
export function CreateWorkflowDialog({ workflows, sourceId, triggerLabel = "Create workflow", triggerVariant = "primary" }: CreateWorkflowDialogProps) {
  const router = useRouter();
  const run = useMutationRunner();
  const live = workflows;
  const defaultSource = sourceId ?? live.find((w) => w.isDefault)?.id ?? live[0]?.id ?? "";
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [from, setFrom] = React.useState<From>(defaultSource ? "workflow" : "default");
  const [source, setSource] = React.useState(defaultSource);
  const [makeDefault, setMakeDefault] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setPending(true);
    const res = await run(
      () =>
        api.post<WorkflowGraph>("/api/workflows", {
          name: name.trim(),
          description: description.trim() || null,
          from,
          sourceWorkflowId: from === "workflow" ? source : undefined,
          isDefault: makeDefault || undefined,
        }),
      { success: `Workflow “${name.trim()}” created`, noRefresh: true },
    );
    setPending(false);
    if (res.ok) {
      setOpen(false);
      router.push(`/settings/workflows/${res.data.workflow.id}`);
    } else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <>
      <Button variant={triggerVariant} leadingIcon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (pending ? undefined : setOpen(o))} size="md">
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Create a workflow</DialogTitle>
            <DialogDescription>Bind it to job types afterwards. Existing jobs keep the workflow they were created with.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-4">
            <FormField label="Name" required error={errors.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} placeholder="Wedding workflow" />
            </FormField>
            <FormField label="Description" optional error={errors.description}>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
            </FormField>
            <div role="radiogroup" aria-label="Start from" className="grid gap-2">
              {FROM_OPTIONS.filter((o) => o.value !== "workflow" || live.length > 0).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={from === o.value}
                  onClick={() => setFrom(o.value)}
                  className={cn(
                    "flex flex-col items-start rounded-md border px-3 py-2.5 text-left transition-colors duration-(--motion-fast) focus-ring",
                    from === o.value ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-hover",
                  )}
                >
                  <span className="text-sm font-medium text-ink">{o.title}</span>
                  <span className="text-xs text-ink-muted">{o.description}</span>
                </button>
              ))}
            </div>
            {from === "workflow" ? (
              <FormField label="Copy from" error={errors.sourceWorkflowId}>
                <Select value={source} onChange={(e) => setSource(e.target.value)}>
                  {live.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                      {w.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
            <Checkbox
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
              label="Make this the studio default"
              description="New job types use the default workflow unless you pick another."
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Create and edit
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}
