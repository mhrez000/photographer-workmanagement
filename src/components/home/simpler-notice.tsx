"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";

/** Where the one-time card is dismissed (services/simple.ts `dismissSimplerNotice`). */
export const SIMPLER_NOTICE_DISMISS_PATH = "/api/me/simpler-notice/dismiss";

/**
 * The one-time "Proofline got simpler" card (docs/SIMPLIFICATION-PLAN.md §6): links to the
 * one-page Help that covers the 5 stages and 3 roles. Dismissing is recorded once per person.
 */
export function SimplerNoticeCard() {
  const router = useRouter();
  const [hidden, setHidden] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  if (hidden) return null;

  const dismiss = async () => {
    setPending(true);
    try {
      await api.post(SIMPLER_NOTICE_DISMISS_PATH, {});
      setHidden(true);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-label="Proofline got simpler"
      className="relative flex flex-col gap-3 rounded-lg border border-accent/20 bg-accent-soft/60 px-5 py-4 text-ink shadow-xs sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3 pr-8 sm:pr-0">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-accent-ink ring-1 ring-inset ring-accent/20">
          <Sparkles aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Proofline got simpler</h2>
          <p className="mt-0.5 text-sm text-ink-secondary">
            Five stages, one list of jobs and one button for the next step. Everything advanced is behind Settings → Studio → Advanced tools.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button href="/help" size="sm" variant="outline">
          How it works
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss} loading={pending} className="hidden sm:inline-flex">
          Got it
        </Button>
      </div>
      <IconButton label="Dismiss" size="sm" onClick={dismiss} disabled={pending} className="absolute right-2 top-2 sm:hidden">
        <X />
      </IconButton>
    </section>
  );
}
