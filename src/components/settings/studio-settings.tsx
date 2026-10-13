"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, Lock, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { ADVANCED_FEATURES, ADVANCED_FEATURE_META } from "@/lib/constants";
import type { SettingsView } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { useConflict } from "./use-conflict";

/* ------------------------------------------------------------------ */
/*  Studio: name, timezone, job number prefix                          */
/* ------------------------------------------------------------------ */

interface StudioFormState {
  organisationName: string;
  timezone: string;
  jobNumberPrefix: string;
}

function initialState(view: SettingsView): StudioFormState {
  return { organisationName: view.organisation.name, timezone: view.settings.timezone, jobNumberPrefix: view.settings.jobNumberPrefix };
}

function diff(view: SettingsView, form: StudioFormState): Record<string, string> {
  const out: Record<string, string> = {};
  if (form.organisationName.trim() !== view.organisation.name) out.organisationName = form.organisationName.trim();
  if (form.timezone !== view.settings.timezone) out.timezone = form.timezone;
  const prefix = form.jobNumberPrefix.trim().toUpperCase();
  if (prefix !== view.settings.jobNumberPrefix) out.jobNumberPrefix = prefix;
  return out;
}

/** Settings → Studio (plan §8 "Kept"): studio name, timezone and the job number prefix. PATCH /api/settings. */
export function StudioForm({ view, timeZones }: { view: SettingsView; timeZones: string[] }) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("settings", view.settings.timezone);
  const readOnly = !view.canManage;
  const [form, setForm] = React.useState<StudioFormState>(() => initialState(view));
  const [baseVersion, setBaseVersion] = React.useState(view.settings.version);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  if (view.settings.version !== baseVersion) {
    setBaseVersion(view.settings.version);
    setForm(initialState(view));
  }

  const changes = diff(view, form);
  const changeCount = Object.keys(changes).length;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || changeCount === 0) return;
    setSaving(true);
    setErrors({});
    const res = await run(() => api.patch("/api/settings", { expectedVersion: view.settings.version, ...changes }), {
      success: "Studio settings saved",
      onConflict,
    });
    setSaving(false);
    if (!res.ok && res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard id="studio" title="Your studio" description="The name people see, the timezone every date uses, and how jobs are numbered.">
      <form onSubmit={save} noValidate className="flex flex-col gap-5">
        {readOnly ? (
          <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-muted">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            Only the owner or a co-owner can change these.
          </p>
        ) : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Studio name" required error={errors.organisationName} className="sm:col-span-2">
            <Input value={form.organisationName} onChange={(e) => setForm((f) => ({ ...f, organisationName: e.target.value }))} disabled={readOnly} maxLength={120} />
          </FormField>
          <FormField label="Timezone" description="Due dates, “late” and every time on screen use this." error={errors.timezone}>
            <Select value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} disabled={readOnly}>
              {timeZones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Job number prefix"
            description={
              <>
                New jobs are numbered like <span className="font-mono text-ink-secondary">{(form.jobNumberPrefix.trim() || "PJ").toUpperCase()}-0142</span>. Existing numbers never change.
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
        {!readOnly ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leadingIcon={<RotateCcw aria-hidden="true" />}
              onClick={() => {
                setForm(initialState(view));
                setErrors({});
              }}
              disabled={saving || changeCount === 0}
            >
              Discard
            </Button>
            <Button type="submit" size="sm" loading={saving} disabled={changeCount === 0} leadingIcon={<Save aria-hidden="true" />}>
              Save
            </Button>
          </div>
        ) : null}
      </form>
      {dialog}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Advanced tools (plan §8)                                           */
/* ------------------------------------------------------------------ */

/** The tools listed under the switch, in plain words. Features without a page are folded into the sentence above. */
const ADVANCED_PAGES = ADVANCED_FEATURES.filter((k) => ADVANCED_FEATURE_META[k].routes.length > 0);

/**
 * Settings → Studio → Advanced tools: one switch, off by default. Turning it on adds the
 * Advanced group to the menu (Board, Timeline, Reports & stats, Automations, Workflows) and
 * brings back the hidden fields. Nothing is deleted either way.
 */
export function AdvancedToolsCard({ view, autoOn }: { view: SettingsView; autoOn: boolean }) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("settings", view.settings.timezone);
  const enabled = view.settings.advancedToolsEnabled;
  const [pending, setPending] = React.useState(false);
  const [showList, setShowList] = React.useState(false);

  const toggle = async (next: boolean) => {
    setPending(true);
    await run(() => api.patch("/api/settings", { expectedVersion: view.settings.version, advancedToolsEnabled: next }), {
      success: next ? "Advanced tools are on" : "Advanced tools are off",
      successDescription: next ? "An Advanced group now shows in the menu." : "Nothing was deleted. Turn it back on any time.",
      onConflict,
    });
    setPending(false);
  };

  return (
    <SectionCard
      id="advanced-tools"
      title="Advanced tools"
      description="Proofline works with five stages and one next button. Everything beyond that is kept here, off by default."
      actions={
        enabled ? (
          <Badge variant="accent" size="sm">
            On
          </Badge>
        ) : (
          <Badge variant="neutral" size="sm">
            Off
          </Badge>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p id="advanced-tools-label" className="text-base font-medium text-ink">
              Show advanced tools
            </p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Adds an <span className="font-medium text-ink-secondary">Advanced</span> group to the menu: a board, a timeline, reports and stats, automations and custom
              workflows. It also brings back the extra fields on jobs and the full permission switches on people. Turning it off hides them again; nothing is lost.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} disabled={!view.canManage || pending} aria-labelledby="advanced-tools-label" aria-busy={pending || undefined} />
        </div>

        {autoOn && enabled ? (
          <p className="flex items-start gap-2 rounded-md border border-info/25 bg-info-soft/40 px-3 py-2 text-sm text-ink-secondary">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info-fg" />
            This studio uses custom workflows or automations, so Advanced tools was switched on for you. Turning it off hides those pages but does not stop them.
          </p>
        ) : null}

        <div>
          <button
            type="button"
            onClick={() => setShowList((s) => !s)}
            aria-expanded={showList}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-ink hover:underline focus-ring rounded-xs"
          >
            <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-(--motion-fast)", showList && "rotate-180")} />
            {showList ? "Hide the list" : "What counts as advanced?"}
          </button>
          {showList ? (
            <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm text-ink-secondary sm:grid-cols-2">
              {ADVANCED_PAGES.map((k) => {
                const meta = ADVANCED_FEATURE_META[k];
                const href = meta.routes[0];
                return (
                  <li key={k} className="flex items-start gap-2">
                    <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
                    {enabled && href ? (
                      <Link href={href} className="hover:text-ink hover:underline">
                        {meta.label}
                      </Link>
                    ) : (
                      <span>{meta.label}</span>
                    )}
                  </li>
                );
              })}
              <li className="flex items-start gap-2">
                <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
                <span>Time tracking, pause / resume, completion %, four priority levels, extra link and note kinds, keyboard chords, display density</span>
              </li>
            </ul>
          ) : null}
        </div>
      </div>
      {dialog}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Close delivered jobs (plan §9)                                     */
/* ------------------------------------------------------------------ */

interface CloseResult {
  ok: string[];
  failed: { id: string; code: string; message: string }[];
}

/**
 * Jobs at Approved or Delivered already show as Done. This optional, owner-confirmed button
 * closes them properly, one job at a time through the normal recorded steps.
 */
export function CloseDeliveredJobsCard({ count, canRun }: { count: number; canRun: boolean }) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<CloseResult | null>(null);

  const confirm = async () => {
    const res = await run(() => api.post<CloseResult>("/api/settings/close-delivered-jobs", { confirm: true }), {
      success: "Delivered jobs closed",
    });
    if (res.ok) setResult(res.data);
    return res.ok || res.handled;
  };

  return (
    <SectionCard
      id="close-delivered"
      title="Close delivered jobs"
      description="Jobs that were approved or delivered already show as Done. This closes them for good, one at a time, and records each step."
      tone="muted"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-secondary">
          {count === 0 ? (
            "Nothing to close right now."
          ) : (
            <>
              <span className="numeric font-medium text-ink">{count}</span> {count === 1 ? "job is" : "jobs are"} delivered but not closed.
            </>
          )}
          {result ? (
            <span className="block text-xs text-ink-muted">
              Last run: {pluralise(result.ok.length, "job")} closed{result.failed.length > 0 ? `, ${result.failed.length} could not be (${result.failed[0]?.message})` : ""}.
            </span>
          ) : null}
        </p>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!canRun || count === 0}>
          Close delivered jobs…
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Close ${pluralise(count, "delivered job")}?`}
        description="Each job moves to Completed through its normal step and the move is recorded in its history. Jobs stay visible under Done. This cannot be undone in bulk."
        confirmLabel="Close them"
        onConfirm={confirm}
      />
    </SectionCard>
  );
}
