"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ArrowRight, CircleAlert, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { MultiSelect, type MultiSelectOption } from "@/components/filters/multi-select";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import {
  LINK_KINDS,
  LINK_KIND_META,
  AUTOMATION_NOTE_KINDS,
  NOTE_KIND_META,
  PRIORITIES,
  PRIORITY_META,
  personaLabel,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type AutomationTriggerType,
  type LinkKind,
  type NoteKind,
  type Priority,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AutomationDetail } from "@/lib/types";
import { automationDefinitionProblems } from "@/lib/validation/automations";
import { cn } from "@/lib/utils";
import { describeRule, type AutomationAction, type AutomationCondition, type AutomationTrigger, type NameLookup } from "./automation-describe";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automation-templates";
import { useConflict } from "./use-conflict";

export interface BuilderPerson {
  id: string;
  name: string;
  role: Role;
  avatarColour: string;
  isActive: boolean;
  /** Roles v2: photographers who are admins show as "Owner / Photographer". */
  isAdmin?: boolean;
}

export interface AutomationBuilderProps {
  rule: AutomationDetail | null;
  users: BuilderPerson[];
  jobTypes: { id: string; name: string; colour: string; archived: boolean }[];
  clients: { id: string; name: string; colour: string }[];
  lookup: NameLookup;
  timeZone: string;
}

/* ------------------------------------------------------------------ */
/*  Defaults & labels                                                  */
/* ------------------------------------------------------------------ */

const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  job_created: "A job is created",
  status_changed: "Status changes",
  job_assigned: "Someone is assigned",
  job_reassigned: "A job is reassigned",
  deadline_changed: "A deadline changes",
  priority_changed: "Priority changes",
  revision_requested: "A revision is requested",
  job_overdue: "A job becomes overdue",
  workload_threshold: "An editor's workload crosses a threshold",
};

function defaultTrigger(type: AutomationTriggerType): AutomationTrigger {
  switch (type) {
    case "status_changed":
      return { type, toCategory: "submitted" };
    case "job_assigned":
    case "job_reassigned":
      return { type, role: "editor" };
    case "workload_threshold":
      return { type, band: "overloaded" };
    default:
      return { type } as AutomationTrigger;
  }
}

type ConditionField = AutomationCondition["field"];
const CONDITION_LABELS: Record<ConditionField, string> = {
  priority: "Priority",
  statusCategory: "Status category",
  jobTypeId: "Job type",
  clientId: "Client",
  editorId: "Editor",
  photographerId: "Photographer",
  revisionCount: "Revision count",
  isOverdue: "Overdue",
  hasLinkKind: "Has link",
};

function defaultCondition(field: ConditionField): AutomationCondition {
  switch (field) {
    case "priority":
      return { field, op: "in", values: ["high", "urgent"] };
    case "statusCategory":
      return { field, op: "in", values: [] };
    case "jobTypeId":
    case "clientId":
    case "photographerId":
      return { field, op: "in", values: [] };
    case "editorId":
      return { field, op: "is_not_null" };
    case "revisionCount":
      return { field, op: "gte", value: 2 };
    case "isOverdue":
      return { field, op: "eq", value: true };
    case "hasLinkKind":
      return { field, op: "missing", kind: "finished_files" };
  }
}

type ActionType = AutomationAction["type"];
const ACTION_LABELS: Record<ActionType, string> = {
  notify: "Send a notification",
  assign_editor: "Assign an editor",
  transition: "Move the job",
  set_priority: "Set priority",
  add_note: "Add a note",
};

function defaultAction(type: ActionType): AutomationAction {
  switch (type) {
    case "notify":
      return { type, target: "photographer" };
    case "assign_editor":
      return { type, target: "previous_editor" };
    case "transition":
      return { type, toCategory: "completed" };
    case "set_priority":
      return { type, priority: "high" };
    case "add_note":
      return { type, kind: "internal", body: "" };
  }
}

const NOTIFY_TARGETS = [
  ["photographer", "The photographer"],
  ["editor", "The editor"],
  ["previous_editor", "The previous editor"],
  ["creator", "Whoever created the job"],
  ["admins", "The owner and admins"],
  ["user", "A specific person…"],
] as const;

/** Values in a condition that need a picker, plus the options for it. */
type Opt = MultiSelectOption;

/* ------------------------------------------------------------------ */
/*  Row editors                                                        */
/* ------------------------------------------------------------------ */

function ConditionRow({
  condition,
  onChange,
  onRemove,
  index,
  options,
}: {
  condition: AutomationCondition;
  onChange: (c: AutomationCondition) => void;
  onRemove: () => void;
  index: number;
  options: { categories: Opt[]; priorities: Opt[]; jobTypes: Opt[]; clients: Opt[]; editors: Opt[]; photographers: Opt[] };
}) {
  const c = condition;
  let body: React.ReactNode = null;
  switch (c.field) {
    case "priority":
      body = <MultiSelect label="Priorities" options={options.priorities} value={c.values} onChange={(v) => onChange({ ...c, values: v as Priority[] })} />;
      break;
    case "statusCategory":
      body = <MultiSelect label="Categories" options={options.categories} value={c.values} onChange={(v) => onChange({ ...c, values: v as StatusCategory[] })} />;
      break;
    case "jobTypeId":
      body = <MultiSelect label="Job types" options={options.jobTypes} value={c.values} onChange={(v) => onChange({ ...c, values: v })} />;
      break;
    case "clientId":
      body = <MultiSelect label="Clients" options={options.clients} value={c.values} onChange={(v) => onChange({ ...c, values: v })} searchable />;
      break;
    case "photographerId":
      body = <MultiSelect label="Photographers" options={options.photographers} value={c.values} onChange={(v) => onChange({ ...c, values: v })} />;
      break;
    case "editorId":
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            value={c.op}
            onChange={(e) => {
              const op = e.target.value as "in" | "is_null" | "is_not_null";
              onChange(op === "in" ? { field: "editorId", op, values: c.values ?? [] } : { field: "editorId", op });
            }}
            aria-label="Editor condition"
            wrapperClassName="w-44"
          >
            <option value="is_not_null">is assigned</option>
            <option value="is_null">is not assigned</option>
            <option value="in">is one of…</option>
          </Select>
          {c.op === "in" ? <MultiSelect label="Editors" options={options.editors} value={c.values ?? []} onChange={(v) => onChange({ ...c, values: v })} /> : null}
        </div>
      );
      break;
    case "revisionCount":
      body = (
        <div className="flex items-center gap-2">
          <Select size="sm" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "gte" | "lte" })} aria-label="Comparison" wrapperClassName="w-28">
            <option value="gte">at least</option>
            <option value="lte">at most</option>
          </Select>
          <Input
            size="sm"
            type="number"
            min={0}
            value={String(c.value)}
            onChange={(e) => onChange({ ...c, value: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className="w-20 numeric"
            aria-label="Revision count"
          />
        </div>
      );
      break;
    case "isOverdue":
      body = (
        <Select size="sm" value={c.value ? "1" : "0"} onChange={(e) => onChange({ ...c, value: e.target.value === "1" })} aria-label="Overdue" wrapperClassName="w-40">
          <option value="1">is overdue</option>
          <option value="0">is not overdue</option>
        </Select>
      );
      break;
    case "hasLinkKind":
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <Select size="sm" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "exists" | "missing" })} aria-label="Link condition" wrapperClassName="w-32">
            <option value="exists">exists</option>
            <option value="missing">is missing</option>
          </Select>
          <Select size="sm" value={c.kind} onChange={(e) => onChange({ ...c, kind: e.target.value as LinkKind })} aria-label="Link kind" wrapperClassName="w-48">
            {LINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {LINK_KIND_META[k].label}
              </option>
            ))}
          </Select>
        </div>
      );
      break;
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 sm:flex-row sm:items-center">
      <span className="w-10 shrink-0 text-2xs font-semibold uppercase tracking-wider text-ink-subtle">{index === 0 ? "If" : "And"}</span>
      <Select
        size="sm"
        value={c.field}
        onChange={(e) => onChange(defaultCondition(e.target.value as ConditionField))}
        aria-label={`Condition ${index + 1} field`}
        wrapperClassName="sm:w-44"
      >
        {(Object.keys(CONDITION_LABELS) as ConditionField[]).map((f) => (
          <option key={f} value={f}>
            {CONDITION_LABELS[f]}
          </option>
        ))}
      </Select>
      <div className="min-w-0 flex-1">{body}</div>
      <IconButton label={`Remove condition ${index + 1}`} size="sm" variant="danger" onClick={onRemove} className="self-end sm:self-auto">
        <Trash2 />
      </IconButton>
    </li>
  );
}

function ActionRow({
  action,
  onChange,
  onRemove,
  index,
  canRemove,
  users,
  editors,
}: {
  action: AutomationAction;
  onChange: (a: AutomationAction) => void;
  onRemove: () => void;
  index: number;
  canRemove: boolean;
  users: BuilderPerson[];
  editors: BuilderPerson[];
}) {
  const a = action;
  let body: React.ReactNode = null;
  switch (a.type) {
    case "notify":
      body = (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Select
              size="sm"
              value={a.target}
              onChange={(e) => onChange({ ...a, target: e.target.value as typeof a.target, userId: e.target.value === "user" ? a.userId : undefined })}
              aria-label="Who to notify"
              wrapperClassName="sm:w-56"
            >
              {NOTIFY_TARGETS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {a.target === "user" ? (
              <Select size="sm" value={a.userId ?? ""} onChange={(e) => onChange({ ...a, userId: e.target.value || undefined })} aria-label="Person to notify" wrapperClassName="sm:w-56">
                <option value="">Choose a person…</option>
                {users
                  .filter((u) => u.role !== "client")
                  .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {personaLabel(u)}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
          <Input size="sm" value={a.message ?? ""} onChange={(e) => onChange({ ...a, message: e.target.value || undefined })} placeholder="Message (optional)" maxLength={500} aria-label="Notification message" />
        </div>
      );
      break;
    case "assign_editor":
      body = (
        <div className="flex flex-wrap gap-2">
          <Select
            size="sm"
            value={a.target}
            onChange={(e) => onChange({ ...a, target: e.target.value as typeof a.target, userId: e.target.value === "user" ? a.userId : undefined })}
            aria-label="Which editor"
            wrapperClassName="sm:w-56"
          >
            <option value="previous_editor">The previous editor</option>
            <option value="original_editor">The original editor</option>
            <option value="user">A specific editor…</option>
          </Select>
          {a.target === "user" ? (
            <Select size="sm" value={a.userId ?? ""} onChange={(e) => onChange({ ...a, userId: e.target.value || undefined })} aria-label="Editor" wrapperClassName="sm:w-56">
              <option value="">Choose an editor…</option>
              {editors.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      );
      break;
    case "transition":
      body = (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select size="sm" value={a.toCategory} onChange={(e) => onChange({ ...a, toCategory: e.target.value as StatusCategory })} aria-label="Target category" wrapperClassName="sm:w-48">
            {STATUS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {STATUS_CATEGORY_META[c].label}
              </option>
            ))}
          </Select>
          <Input size="sm" value={a.reason ?? ""} onChange={(e) => onChange({ ...a, reason: e.target.value || undefined })} placeholder="Reason (recorded in history)" maxLength={500} aria-label="Reason" />
        </div>
      );
      break;
    case "set_priority":
      body = (
        <Select size="sm" value={a.priority} onChange={(e) => onChange({ ...a, priority: e.target.value as Priority })} aria-label="Priority" wrapperClassName="sm:w-40">
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_META[p].label}
            </option>
          ))}
        </Select>
      );
      break;
    case "add_note":
      body = (
        <div className="flex flex-col gap-2">
          <Select size="sm" value={a.kind} onChange={(e) => onChange({ ...a, kind: e.target.value as NoteKind })} aria-label="Note kind" wrapperClassName="sm:w-48">
            {AUTOMATION_NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {NOTE_KIND_META[k].label}
              </option>
            ))}
          </Select>
          <Textarea value={a.body} onChange={(e) => onChange({ ...a, body: e.target.value })} rows={2} maxLength={5000} placeholder="Note text" aria-label="Note text" />
        </div>
      );
      break;
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 sm:flex-row sm:items-start">
      <span className="w-10 shrink-0 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-accent-ink">{index === 0 ? "Then" : "And"}</span>
      <Select
        size="sm"
        value={a.type}
        onChange={(e) => onChange(defaultAction(e.target.value as ActionType))}
        aria-label={`Action ${index + 1} type`}
        wrapperClassName="sm:w-48"
      >
        {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => (
          <option key={t} value={t}>
            {ACTION_LABELS[t]}
          </option>
        ))}
      </Select>
      <div className="min-w-0 flex-1">{body}</div>
      {canRemove ? (
        <IconButton label={`Remove action ${index + 1}`} size="sm" variant="danger" onClick={onRemove} className="self-end sm:self-auto">
          <Trash2 />
        </IconButton>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

export function AutomationBuilder({ rule, users, jobTypes, clients, lookup, timeZone }: AutomationBuilderProps) {
  const router = useRouter();
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("rule", timeZone);
  const [name, setName] = React.useState(rule?.name ?? "");
  const [description, setDescription] = React.useState(rule?.description ?? "");
  const [isEnabled, setIsEnabled] = React.useState(rule?.isEnabled ?? true);
  const [trigger, setTrigger] = React.useState<AutomationTrigger>(rule?.trigger ?? defaultTrigger("status_changed"));
  const [conditions, setConditions] = React.useState<AutomationCondition[]>(rule?.conditions ?? []);
  const [actions, setActions] = React.useState<AutomationAction[]>(rule?.actions ?? [defaultAction("notify")]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [version, setVersion] = React.useState(rule?.version ?? 0);

  // Server refresh after a save → adopt the stored definition.
  if (rule && rule.version !== version) {
    setVersion(rule.version);
    setName(rule.name);
    setDescription(rule.description ?? "");
    setTrigger(rule.trigger);
    setConditions(rule.conditions);
    setActions(rule.actions);
  }

  const active = users.filter((u) => u.isActive);
  const editors = active.filter((u) => u.role === "editor");
  const options = React.useMemo(
    () => ({
      categories: STATUS_CATEGORIES.map((c) => ({ value: c, label: STATUS_CATEGORY_META[c].label, colour: STATUS_CATEGORY_META[c].hex })),
      priorities: PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label, colour: PRIORITY_META[p].hex })),
      jobTypes: jobTypes.filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.name, colour: t.colour })),
      clients: clients.map((c) => ({ value: c.id, label: c.name, colour: c.colour })),
      editors: users.filter((u) => u.role === "editor").map((u) => ({ value: u.id, label: u.name, description: u.isActive ? undefined : "Deactivated" })),
      photographers: users.filter((u) => u.role === "photographer").map((u) => ({ value: u.id, label: u.name, description: personaLabel(u) })),
    }),
    [users, jobTypes, clients],
  );

  const problems = automationDefinitionProblems(trigger, conditions, actions);
  const emptyValues = conditions.some((c) => "values" in c && c.op === "in" && (!c.values || c.values.length === 0));
  const noteMissing = actions.some((a) => a.type === "add_note" && a.body.trim() === "");
  const sentence = describeRule({ trigger, conditions, actions }, lookup);

  const applyTemplate = (t: AutomationTemplate) => {
    setName(t.name);
    setDescription(t.description);
    setTrigger(t.trigger);
    setConditions(t.conditions);
    setActions(t.actions);
    setErrors({});
    setFormError(null);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErrors({});
    setFormError(null);
    if (problems.length > 0 || emptyValues || noteMissing) {
      setFormError(problems[0] ?? (emptyValues ? "Pick at least one value for each “is one of” condition" : "Write the note text"));
      return;
    }
    setSaving(true);
    const definition = {
      name: name.trim(),
      description: description.trim() || null,
      trigger,
      conditions,
      actions: actions.map((a) => (a.type === "add_note" ? { ...a, body: a.body.trim() } : a)),
    };
    const res = rule
      ? await run(() => api.patch(`/api/automations/${rule.id}`, { expectedVersion: rule.version, ...definition }), { success: "Rule saved", onConflict })
      : await run(() => api.post<{ id: string }>("/api/automations", { ...definition, isEnabled }), { success: "Rule created", noRefresh: true });
    setSaving(false);
    if (res.ok && !rule) {
      router.replace(`/settings/automations/${(res.data as { id: string }).id}`);
      router.refresh();
    } else if (!res.ok && res.fieldErrors) {
      const fe = firstFieldErrors(res.fieldErrors);
      setErrors(fe);
      if (!fe.name) setFormError(Object.values(fe)[0] ?? "Check the rule");
    }
  };

  const triggerFilters = (() => {
    switch (trigger.type) {
      case "status_changed":
        return (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="From category" optional>
              <Select value={trigger.fromCategory ?? ""} onChange={(e) => setTrigger({ ...trigger, fromCategory: (e.target.value || undefined) as StatusCategory | undefined })}>
                <option value="">Any status</option>
                {STATUS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {STATUS_CATEGORY_META[c].label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="To category" optional>
              <Select value={trigger.toCategory ?? ""} onChange={(e) => setTrigger({ ...trigger, toCategory: (e.target.value || undefined) as StatusCategory | undefined })}>
                <option value="">Any status</option>
                {STATUS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {STATUS_CATEGORY_META[c].label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Exact status key" optional description="Narrow to one status of a custom workflow (e.g. client_review)." className="sm:col-span-2">
              <Input value={trigger.toStatusKey ?? ""} onChange={(e) => setTrigger({ ...trigger, toStatusKey: e.target.value.trim() || undefined })} mono maxLength={64} />
            </FormField>
          </div>
        );
      case "job_assigned":
      case "job_reassigned":
        return (
          <FormField label="Role">
            <Select value={trigger.role} onChange={(e) => setTrigger({ ...trigger, role: e.target.value as "editor" | "photographer" })}>
              <option value="editor">Editor</option>
              <option value="photographer">Photographer</option>
            </Select>
          </FormField>
        );
      case "deadline_changed":
        return (
          <FormField label="Deadline" optional>
            <Select value={trigger.field ?? ""} onChange={(e) => setTrigger({ ...trigger, field: (e.target.value || undefined) as "dueDate" | "reviewDueDate" | "deliveryDueDate" | undefined })}>
              <option value="">Any deadline</option>
              <option value="dueDate">Due date</option>
              <option value="reviewDueDate">Review deadline</option>
              <option value="deliveryDueDate">Delivery deadline</option>
            </Select>
          </FormField>
        );
      case "priority_changed":
        return (
          <FormField label="New priority" optional>
            <Select value={trigger.toPriority ?? ""} onChange={(e) => setTrigger({ ...trigger, toPriority: (e.target.value || undefined) as Priority | undefined })}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </Select>
          </FormField>
        );
      case "workload_threshold":
        return (
          <FormField label="Band" description="Workload rules aren't about one job, so they can only send notifications.">
            <Select value={trigger.band} onChange={(e) => setTrigger({ ...trigger, band: e.target.value as "near_capacity" | "overloaded" })}>
              <option value="near_capacity">Near capacity</option>
              <option value="overloaded">Overloaded</option>
            </Select>
          </FormField>
        );
      default:
        return null;
    }
  })();

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-6">
      {!rule ? (
        <SectionCard eyebrow="Templates" title="Start from an example" description="Pick one to fill in the rule, then adjust anything." actions={<Sparkles aria-hidden="true" className="size-4 text-accent-ink" />}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {AUTOMATION_TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className={cn(
                    "flex h-full w-full flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-(--motion-fast) focus-ring",
                    name === t.name ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-hover hover:bg-surface-muted/60",
                  )}
                >
                  <span className="text-sm font-medium text-ink">{t.name}</span>
                  <span className="text-xs text-ink-muted">{t.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Rule">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" required error={errors.name} className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Tell the photographer when work is submitted" />
          </FormField>
          <FormField label="Description" optional className="sm:col-span-2" error={errors.description}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} />
          </FormField>
          {!rule ? (
            <Switch checked={isEnabled} onCheckedChange={setIsEnabled} label="Enabled" description="Start running as soon as it's saved." wrapperClassName="sm:col-span-2" />
          ) : null}
        </div>
      </SectionCard>

      <SectionCard eyebrow="1" title="When…" description="The event that starts the rule.">
        <div className="flex flex-col gap-4">
          <FormField label="Trigger">
            <Select value={trigger.type} onChange={(e) => setTrigger(defaultTrigger(e.target.value as AutomationTriggerType))}>
              {(Object.keys(TRIGGER_LABELS) as AutomationTriggerType[]).map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t]}
                </option>
              ))}
            </Select>
          </FormField>
          {triggerFilters}
        </div>
      </SectionCard>

      <SectionCard
        eyebrow="2"
        title="Only if…"
        description="All conditions must hold (AND). Leave empty to always run."
        actions={
          trigger.type !== "workload_threshold" ? (
            <Button size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setConditions((cs) => [...cs, defaultCondition("priority")])} disabled={conditions.length >= 20}>
              Add condition
            </Button>
          ) : undefined
        }
      >
        {conditions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-strong px-3 py-3 text-sm text-ink-muted">No conditions — the rule runs every time the trigger fires.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {conditions.map((c, i) => (
              <ConditionRow
                key={i}
                index={i}
                condition={c}
                options={options}
                onChange={(next) => setConditions((cs) => cs.map((x, j) => (j === i ? next : x)))}
                onRemove={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
              />
            ))}
          </ol>
        )}
      </SectionCard>

      <SectionCard
        eyebrow="3"
        title="Then…"
        description="Actions run in order, as the system (recorded with this rule's name)."
        actions={
          <Button size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setActions((as) => [...as, defaultAction("notify")])} disabled={actions.length >= 10}>
            Add action
          </Button>
        }
      >
        <ol className="flex flex-col gap-2">
          {actions.map((a, i) => (
            <ActionRow
              key={i}
              index={i}
              action={a}
              users={active}
              editors={editors}
              canRemove={actions.length > 1}
              onChange={(next) => setActions((as) => as.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setActions((as) => as.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      </SectionCard>

      <div className="sticky bottom-[calc(var(--tabbar-height)+0.75rem)] z-(--z-page-sticky) flex flex-col gap-3 rounded-lg border border-border bg-surface-raised/95 p-4 shadow-pop backdrop-blur lg:bottom-4">
        <p className="text-sm leading-relaxed text-ink-secondary" aria-live="polite">
          <span className="font-medium text-ink">{sentence.trigger}</span>
          {sentence.conditions ? <span> {sentence.conditions}</span> : null}
          <ArrowRight aria-label="then" className="mx-1.5 inline size-3.5 align-[-2px] text-accent-ink" />
          {sentence.actions}
        </p>
        {problems.length > 0 || formError ? (
          <ul className="flex flex-col gap-1 text-sm text-danger" role="alert">
            {(formError && !problems.includes(formError) ? [formError, ...problems] : problems).map((p) => (
              <li key={p} className="flex items-start gap-1.5">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {rule ? (
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft" leadingIcon={<Archive aria-hidden="true" />} onClick={() => setArchiveOpen(true)}>
              Archive rule
            </Button>
          ) : (
            <Button variant="ghost" size="sm" href="/settings/automations">
              Cancel
            </Button>
          )}
          <Button type="submit" loading={saving} leadingIcon={<Save aria-hidden="true" />} disabled={!name.trim()}>
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </div>
      </div>

      {rule ? (
        <ConfirmDialog
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
          title={`Archive “${rule.name}”?`}
          description="It stops running immediately. Its run history is kept."
          confirmLabel="Archive rule"
          destructive
          onConfirm={async () => {
            const res = await run(() => api.post(`/api/automations/${rule.id}/archive`, { expectedVersion: rule.version }), { success: "Rule archived", noRefresh: true, onConflict });
            if (res.ok) router.push("/settings/automations");
            return res.ok || res.handled;
          }}
        />
      ) : null}
      {dialog}
    </form>
  );
}
