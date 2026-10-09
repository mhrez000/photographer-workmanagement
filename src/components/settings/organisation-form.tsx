"use client";

import * as React from "react";
import { Lock, RotateCcw, Save } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { ConflictDialog } from "@/components/jobs/conflict-dialog";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type ApiError } from "@/lib/api-client";
import type { SettingsView } from "@/lib/types";
import { cn } from "@/lib/utils";

type NumberKey =
  | "workSessionAutoTimeoutMinutes"
  | "defaultCapacityHoursPerWeek"
  | "defaultEstimatedHours"
  | "workloadNearCapacityRatio"
  | "workloadOverloadedRatio"
  | "maxActiveJobsPerEditor"
  | "reviewBottleneckHours"
  | "reviewBottleneckMinJobs"
  | "editingBottleneckDueWithinHours"
  | "editingBottleneckMinDueSoon"
  | "unassignedBacklogMin"
  | "stalledDays"
  | "revisionSpikeMinCount"
  | "revisionSpikeMultiplier"
  | "reviewSlaHours";

type BoolKey =
  | "timeTrackingEnabled"
  | "photographersSeeAllJobs"
  | "photographersSeeTeamJobs"
  | "editorsSeeTeamJobs"
  | "editorsSeeTeamWorkloads"
  | "automationsEnabled"
  | "auditNotifications";

interface FormState {
  organisationName: string;
  timezone: string;
  weekStartsOn: string;
  jobNumberPrefix: string;
  numbers: Record<NumberKey, string>;
  bools: Record<BoolKey, boolean>;
}

const NUMBER_KEYS: NumberKey[] = [
  "workSessionAutoTimeoutMinutes",
  "defaultCapacityHoursPerWeek",
  "defaultEstimatedHours",
  "workloadNearCapacityRatio",
  "workloadOverloadedRatio",
  "maxActiveJobsPerEditor",
  "reviewBottleneckHours",
  "reviewBottleneckMinJobs",
  "editingBottleneckDueWithinHours",
  "editingBottleneckMinDueSoon",
  "unassignedBacklogMin",
  "stalledDays",
  "revisionSpikeMinCount",
  "revisionSpikeMultiplier",
  "reviewSlaHours",
];
const BOOL_KEYS: BoolKey[] = [
  "timeTrackingEnabled",
  "photographersSeeAllJobs",
  "photographersSeeTeamJobs",
  "editorsSeeTeamJobs",
  "editorsSeeTeamWorkloads",
  "automationsEnabled",
  "auditNotifications",
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function initialState(view: SettingsView): FormState {
  const s = view.settings;
  return {
    organisationName: view.organisation.name,
    timezone: s.timezone,
    weekStartsOn: String(s.weekStartsOn),
    jobNumberPrefix: s.jobNumberPrefix,
    numbers: Object.fromEntries(NUMBER_KEYS.map((k) => [k, String(s[k])])) as Record<NumberKey, string>,
    bools: Object.fromEntries(BOOL_KEYS.map((k) => [k, Boolean(s[k])])) as Record<BoolKey, boolean>,
  };
}

/** Field → value diff against the stored settings (only what changed is sent). */
function diff(view: SettingsView, form: FormState): Record<string, string | number | boolean> {
  const s = view.settings;
  const out: Record<string, string | number | boolean> = {};
  if (form.organisationName.trim() !== view.organisation.name) out.organisationName = form.organisationName.trim();
  if (form.timezone !== s.timezone) out.timezone = form.timezone;
  if (Number(form.weekStartsOn) !== s.weekStartsOn) out.weekStartsOn = Number(form.weekStartsOn);
  if (form.jobNumberPrefix.trim().toUpperCase() !== s.jobNumberPrefix) out.jobNumberPrefix = form.jobNumberPrefix.trim().toUpperCase();
  for (const k of NUMBER_KEYS) {
    const raw = form.numbers[k].trim();
    const n = raw === "" ? NaN : Number(raw);
    if (n !== s[k]) out[k] = n;
  }
  for (const k of BOOL_KEYS) if (form.bools[k] !== Boolean(s[k])) out[k] = form.bools[k];
  return out;
}

/**
 * /settings/organisation form. Owners edit (PATCH /api/settings with the
 * settings version, only changed fields); managers see it read-only.
 */
export function OrganisationSettingsForm({ view, timeZones }: { view: SettingsView; timeZones: string[] }) {
  const run = useMutationRunner();
  const readOnly = !view.canManage;
  const [form, setForm] = React.useState<FormState>(() => initialState(view));
  const [baseVersion, setBaseVersion] = React.useState(view.settings.version);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  // A refreshed server view (after a save or a reload) resets the baseline.
  if (view.settings.version !== baseVersion) {
    setBaseVersion(view.settings.version);
    setForm(initialState(view));
  }

  const changes = diff(view, form);
  const changeCount = Object.keys(changes).length;
  const zones = timeZones;

  const setNumber = (k: NumberKey) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, numbers: { ...f.numbers, [k]: e.target.value } }));
  const setBool = (k: BoolKey) => (v: boolean) => setForm((f) => ({ ...f, bools: { ...f.bools, [k]: v } }));

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (readOnly || changeCount === 0) return;
    setSaving(true);
    setErrors({});
    const result = await run(() => api.patch<{ changedFields: string[] }>("/api/settings", { expectedVersion: view.settings.version, ...changes }), {
      success: changeCount === 1 ? "Setting saved" : `${changeCount} settings saved`,
      onConflict: (err) => setConflict(err),
    });
    setSaving(false);
    if (!result.ok && result.fieldErrors) setErrors(firstFieldErrors(result.fieldErrors));
  };

  const numberField = (
    k: NumberKey,
    label: string,
    description: React.ReactNode,
    opts: { step?: string; suffix?: string; min?: number } = {},
  ) => (
    <FormField label={label} description={description} error={errors[k]}>
      <Input
        type="number"
        inputMode="decimal"
        step={opts.step ?? "1"}
        min={opts.min ?? 0}
        value={form.numbers[k]}
        onChange={setNumber(k)}
        disabled={readOnly}
        trailing={opts.suffix ? <span className="text-xs">{opts.suffix}</span> : undefined}
        className={cn("numeric", opts.suffix && opts.suffix.length > 3 && "pr-16")}
      />
    </FormField>
  );

  const toggle = (k: BoolKey, label: string, description: React.ReactNode) => (
    <div className="flex items-start justify-between gap-6 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p id={`${k}-label`} className="text-base font-medium text-ink">
          {label}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        {errors[k] ? <p className="mt-1 text-sm text-danger">{errors[k]}</p> : null}
      </div>
      <Switch checked={form.bools[k]} onCheckedChange={setBool(k)} disabled={readOnly} aria-labelledby={`${k}-label`} />
    </div>
  );

  return (
    <form onSubmit={save} className="flex flex-col gap-6" noValidate>
      {readOnly ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-secondary">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <p>
            You can view these settings. Only an <span className="font-medium text-ink">owner</span> can change them.
          </p>
        </div>
      ) : null}

      <SectionCard id="general" eyebrow="Studio" title="General" description="How your studio appears and how dates and job numbers work.">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Studio name" error={errors.organisationName} className="sm:col-span-2" required>
            <Input
              value={form.organisationName}
              onChange={(e) => setForm((f) => ({ ...f, organisationName: e.target.value }))}
              disabled={readOnly}
              maxLength={120}
            />
          </FormField>
          <FormField label="Timezone" description="Due today, overdue and every date on screen use this zone." error={errors.timezone}>
            <Select value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} disabled={readOnly}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Week starts on" description="Used for “this week” ranges and reports." error={errors.weekStartsOn}>
            <Select value={form.weekStartsOn} onChange={(e) => setForm((f) => ({ ...f, weekStartsOn: e.target.value }))} disabled={readOnly}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={String(i)}>
                  {d}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Job number prefix"
            description={
              <>
                New jobs are numbered like{" "}
                <span className="font-mono text-ink-secondary">{(form.jobNumberPrefix.trim() || "PJ").toUpperCase()}-0142</span>. Existing numbers never
                change.
              </>
            }
            error={errors.jobNumberPrefix}
          >
            <Input
              value={form.jobNumberPrefix}
              onChange={(e) => setForm((f) => ({ ...f, jobNumberPrefix: e.target.value.toUpperCase() }))}
              disabled={readOnly}
              maxLength={8}
              mono
              className="uppercase"
            />
          </FormField>
        </div>
      </SectionCard>

      <SectionCard id="time-tracking" eyebrow="Production" title="Time tracking" description="Optional Start / Pause / Stop timers on jobs.">
        <div className="flex flex-col divide-y divide-border">
          {toggle(
            "timeTrackingEnabled",
            "Enable time tracking",
            "Editors (and photographers on their own jobs) can run a timer. Totals appear on the job's Time tab.",
          )}
        </div>
        <div className={cn("mt-4 grid gap-5 sm:grid-cols-2", !form.bools.timeTrackingEnabled && "opacity-60")}>
          {numberField("workSessionAutoTimeoutMinutes", "Auto-stop forgotten timers after", "Sessions running longer than this are closed automatically.", {
            suffix: "min",
            min: 15,
          })}
        </div>
      </SectionCard>

      <SectionCard
        id="workload"
        eyebrow="Team"
        title="Workload & bottleneck thresholds"
        description="When an editor counts as near capacity or overloaded, and when the dashboard raises a bottleneck."
      >
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="mb-3 text-sm font-semibold text-ink">Capacity</h3>
            <div className="grid gap-5 sm:grid-cols-2">
              {numberField("defaultCapacityHoursPerWeek", "Default capacity", "Used for anyone without their own capacity.", {
                suffix: "h/wk",
                step: "0.5",
                min: 1,
              })}
              {numberField("defaultEstimatedHours", "Default hours per job", "When neither the job nor its type has an estimate.", { suffix: "h", step: "0.1" })}
              {numberField("workloadNearCapacityRatio", "Near capacity at", "Workload score ÷ capacity. 0.7 = 70 %.", { step: "0.05", suffix: "×" })}
              {numberField("workloadOverloadedRatio", "Overloaded at", "1.0 = a full week of estimated work.", { step: "0.05", suffix: "×" })}
              {numberField("maxActiveJobsPerEditor", "Max active jobs per editor", "Reaching this marks the editor overloaded regardless of hours.", {
                suffix: "jobs",
                min: 1,
              })}
            </div>
          </div>
          <div className="border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-semibold text-ink">Bottlenecks</h3>
            <div className="grid gap-5 sm:grid-cols-2">
              {numberField("reviewBottleneckHours", "Review waiting longer than", "Jobs waiting for review this long count toward a review bottleneck.", {
                suffix: "h",
                min: 1,
              })}
              {numberField("reviewBottleneckMinJobs", "…when at least", "Waiting jobs needed to raise the alert.", { suffix: "jobs", min: 1 })}
              {numberField("editingBottleneckDueWithinHours", "Editing due-soon window", "What “due soon” means for the editing bottleneck.", {
                suffix: "h",
                min: 1,
              })}
              {numberField("editingBottleneckMinDueSoon", "…with at least", "Jobs due within the window for one editor.", { suffix: "jobs", min: 1 })}
              {numberField("unassignedBacklogMin", "Unassigned backlog at", "Jobs waiting for an editor.", { suffix: "jobs", min: 1 })}
              {numberField("stalledDays", "Stalled after", "Active, not paused, and no activity for this long.", { suffix: "days", min: 1 })}
              {numberField("revisionSpikeMinCount", "Revision spike at", "Revisions requested in the last 7 days.", { suffix: "revs", min: 1 })}
              {numberField("revisionSpikeMultiplier", "…and above the 4-week average by", "1.5 = 50 % more than usual.", {
                step: "0.1",
                suffix: "×",
                min: 1,
              })}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="review-sla" eyebrow="Production" title="Review SLA" description="How quickly submitted work should be reviewed.">
        <div className="grid gap-5 sm:grid-cols-2">
          {numberField("reviewSlaHours", "Default review deadline", "Work submitted without a review deadline gets one this many hours later.", {
            suffix: "h",
            min: 1,
          })}
        </div>
      </SectionCard>

      <SectionCard
        id="visibility"
        eyebrow="Access"
        title="Visibility"
        description="What photographers and editors can see beyond their own work. Owners and managers always see everything."
      >
        <div className="flex flex-col divide-y divide-border">
          {toggle("photographersSeeAllJobs", "Photographers see all jobs", "Every photographer can open every job in the studio.")}
          {toggle("photographersSeeTeamJobs", "Photographers see their team's jobs", "Jobs whose photographer or editor shares a team with them.")}
          {toggle("editorsSeeTeamJobs", "Editors see their team's jobs", "Read-only access to teammates' jobs.")}
          {toggle(
            "editorsSeeTeamWorkloads",
            "Editors see team workloads",
            "Aggregate counts only, never job details. Photographers get this per person in Users.",
          )}
        </div>
      </SectionCard>

      <SectionCard id="automations" eyebrow="Engine" title="Automations" description="The kill switch stops every rule at once without editing them.">
        <div className="flex flex-col divide-y divide-border">
          {toggle("automationsEnabled", "Run automations", "When off, rules record a skipped run so you can see what would have happened.")}
          {toggle("auditNotifications", "Record every notification in the activity log", "Useful for audits; makes the feed noisier.")}
        </div>
      </SectionCard>

      {!readOnly ? (
        <div
          className={cn(
            "sticky bottom-[calc(var(--tabbar-height)+0.75rem)] z-20 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised/95 px-4 py-3 shadow-pop backdrop-blur transition-[opacity,transform] duration-(--motion-base) lg:bottom-4",
            changeCount === 0 && "pointer-events-none translate-y-2 opacity-0",
          )}
          aria-hidden={changeCount === 0}
        >
          <p className="text-sm text-ink-secondary" aria-live="polite">
            <span className="numeric font-medium text-ink">{changeCount}</span> unsaved {changeCount === 1 ? "change" : "changes"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<RotateCcw aria-hidden="true" />}
              onClick={() => {
                setForm(initialState(view));
                setErrors({});
              }}
              disabled={saving || changeCount === 0}
              tabIndex={changeCount === 0 ? -1 : undefined}
            >
              Discard
            </Button>
            <Button
              type="submit"
              size="sm"
              loading={saving}
              leadingIcon={<Save aria-hidden="true" />}
              disabled={changeCount === 0}
              tabIndex={changeCount === 0 ? -1 : undefined}
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(o) => !o && setConflict(null)}
        error={conflict ?? undefined}
        entity="settings"
      />
    </form>
  );
}
