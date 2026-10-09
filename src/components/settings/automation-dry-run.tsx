"use client";

import * as React from "react";
import Link from "next/link";
import { CircleCheck, CircleHelp, CircleX, FlaskConical, Play } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, api, errorMessage } from "@/lib/api-client";
import type { AutomationDryRunResult, JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const JOB_NUMBER = /^[A-Za-z][A-Za-z0-9]{0,7}-\d+$/;

function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <CircleHelp aria-label="Unknown" className="size-4 shrink-0 text-ink-subtle" />;
  return ok ? <CircleCheck aria-label="Yes" className="size-4 shrink-0 text-success" /> : <CircleX aria-label="No" className="size-4 shrink-0 text-danger" />;
}

/** Test a saved rule against a real job without changing anything. */
export function AutomationDryRun({ automationId }: { automationId: string }) {
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<AutomationDryRunResult | null>(null);

  const test = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      let jobId = q;
      if (JOB_NUMBER.test(q)) {
        const job = await api.get<JobRow>(`/api/jobs/by-number/${encodeURIComponent(q.toUpperCase())}`);
        jobId = job.id;
      }
      setResult(await api.post<AutomationDryRunResult>(`/api/automations/${automationId}/dry-run`, { jobId }));
    } catch (err) {
      setError(err instanceof ApiError && err.code === "not_found" ? `No job “${q}” that you can see.` : errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <SectionCard
      id="dry-run"
      title="Dry run"
      description="Check what this rule would do to a job — nothing is written. It tests the saved version of the rule."
      actions={<FlaskConical aria-hidden="true" className="size-4 text-ink-subtle" />}
    >
      <form onSubmit={test} className="flex flex-col gap-2 sm:flex-row">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Job number (PJ-0042) or id" aria-label="Job number or id" mono />
        <Button type="submit" variant="outline" loading={pending} leadingIcon={<Play aria-hidden="true" />} disabled={!query.trim()}>
          Test
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-4 flex animate-fade-in flex-col gap-4">
          <div
            className={cn(
              "flex items-start gap-3 rounded-md px-3 py-2.5 text-sm",
              result.wouldRun ? "bg-success-soft text-success-fg" : "bg-surface-sunken text-ink-secondary",
            )}
          >
            <Mark ok={result.wouldRun} />
            <p>
              On{" "}
              <Link href={`/jobs/${result.job.id}`} className="font-medium underline underline-offset-2">
                {result.job.jobNumber} {result.job.name}
              </Link>{" "}
              this rule <strong>{result.wouldRun ? "would run" : "would not run"}</strong>
              {result.blockedBy ? ` — ${result.blockedBy}` : ""}.
            </p>
          </div>
          <dl className="flex flex-col gap-3 text-sm">
            <div>
              <dt className="eyebrow mb-1.5">Trigger</dt>
              <dd className="flex items-start gap-2 text-ink-secondary">
                <Mark ok={result.trigger.matched} />
                {result.trigger.detail}
              </dd>
            </div>
            <div>
              <dt className="eyebrow mb-1.5">Conditions</dt>
              <dd>
                {result.conditions.length === 0 ? (
                  <span className="text-ink-muted">None — always passes.</span>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {result.conditions.map((c, i) => (
                      <li key={i} className="flex items-start gap-2 text-ink-secondary">
                        <Mark ok={c.met} />
                        {c.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="eyebrow mb-1.5">Actions</dt>
              <dd>
                <ul className="flex flex-col gap-1.5">
                  {result.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 text-ink-secondary">
                      <Mark ok={a.problem === null} />
                      <span>
                        {a.description}
                        {a.problem ? <span className="block text-xs text-danger">{a.problem}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </SectionCard>
  );
}
