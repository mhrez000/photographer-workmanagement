"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { OnboardingState } from "@/server/queries/onboarding";

/** Where the checklist is hidden for every admin of the studio (services/settings.ts `dismissOnboarding`). */
export const ONBOARDING_DISMISS_PATH = "/api/settings/onboarding/dismiss";

interface Step {
  key: keyof OnboardingState["steps"];
  label: string;
  hint: string;
  href: string;
  cta: string;
}

/** The five steps, in the order a new studio does them (src/server/queries/onboarding.ts). */
export const SET_UP_STEPS: readonly Step[] = [
  { key: "createdFirstJob", label: "Create your first job", hint: "Client, address, shoot date — eight fields.", href: "/jobs/new", cta: "New job" },
  { key: "invitedEditor", label: "Invite an editor", hint: "They get a link to choose their own password.", href: "/settings/people?invite=editor", cta: "Invite" },
  { key: "addedClient", label: "Add a client", hint: "So jobs and the portal know who the work is for.", href: "/clients", cta: "Clients" },
  { key: "assignedEditor", label: "Give a job to an editor", hint: "Pick an editor on the job, or when you create it.", href: "/jobs?stage=needs_editor", cta: "Jobs" },
  { key: "approvedFirst", label: "Approve your first job", hint: "Ready to check is your turn: Approve or Ask for changes.", href: "/jobs?stage=ready_to_check", cta: "Check" },
];

export interface GetSetUpCardProps {
  state: OnboardingState;
  /** The empty-studio layout: bigger, no dismiss button in the corner. */
  prominent?: boolean;
  className?: string;
}

/**
 * "Get set up" — the first-run checklist for owners (front door, `GET /api/settings/onboarding`): five
 * steps with ticks, each a link to the obvious next place; the one Dismiss (footer) hides it for every owner of the studio.
 * The page shows it only while the server says `show` (new studio, not dismissed, not every step done).
 */
export function GetSetUpCard({ state, prominent = false, className }: GetSetUpCardProps) {
  const router = useRouter();
  const [hidden, setHidden] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  if (hidden) return null;

  const dismiss = async () => {
    setPending(true);
    try {
      await api.post(ONBOARDING_DISMISS_PATH, {});
      setHidden(true);
      toast.success("Checklist hidden", "You can still do every step from the menu.");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const next = SET_UP_STEPS.find((s) => !state.steps[s.key]);

  return (
    <section
      aria-labelledby="get-set-up-title"
      data-get-set-up=""
      className={cn("relative flex flex-col gap-4 rounded-lg border border-border bg-surface shadow-xs", prominent ? "p-5 sm:p-6" : "p-5", className)}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="get-set-up-title" className={cn("font-semibold text-ink", prominent ? "text-xl" : "text-md")}>
            Get set up
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {state.completed === 0 ? "Five small steps and your studio is running." : `${state.completed} of ${state.total} done${next ? ` · next: ${next.label.toLowerCase()}` : ""}.`}
          </p>
        </div>
        <div className="flex items-center gap-3 sm:w-56">
          <Progress value={state.completed} max={state.total} size="sm" label="Set-up progress" className="min-w-0 flex-1" />
          <span className="numeric shrink-0 text-xs text-ink-muted">
            {state.completed}/{state.total}
          </span>
        </div>
      </header>

      <ol className="-mx-1 flex flex-col">
        {SET_UP_STEPS.map((step, i) => {
          const done = state.steps[step.key];
          const isNext = next?.key === step.key;
          return (
            <li key={step.key} data-step={step.key} data-done={done ? "true" : "false"}>
              <Link
                href={step.href}
                aria-current={isNext ? "step" : undefined}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-(--motion-fast) focus-ring hover:bg-surface-muted",
                  isNext && "bg-accent-soft/40",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset",
                    done ? "bg-success text-white ring-success" : isNext ? "bg-surface text-accent-ink ring-accent" : "bg-surface text-ink-muted ring-border-strong",
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm font-medium", done ? "text-ink-muted line-through decoration-ink-subtle" : "text-ink")}>
                    {step.label}
                    {done ? <span className="sr-only"> (done)</span> : null}
                  </span>
                  {!done ? <span className="block text-xs text-ink-muted">{step.hint}</span> : null}
                </span>
                {!done ? (
                  <span className={cn("inline-flex shrink-0 items-center gap-1 text-sm font-medium", isNext ? "text-accent-ink" : "text-ink-muted group-hover:text-ink")}>
                    <span className="hidden sm:inline">{step.cta}</span>
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>

      {/* One way to close the card (the corner X was a second, duplicate control on phones). */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-ink-muted">Ticks fill in by themselves as you go.</p>
        <Button size="sm" variant="ghost" onClick={dismiss} loading={pending} data-dismiss-checklist="">
          Dismiss
        </Button>
      </footer>
    </section>
  );
}
