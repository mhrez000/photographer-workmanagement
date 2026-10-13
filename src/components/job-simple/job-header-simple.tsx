import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SimpleDueChip } from "@/components/jobs-list/simple-due-chip";
import { RoundBadge, RushBadge, StagePill } from "@/components/jobs/stage-pill";
import type { SimpleJobPage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { JobMenu } from "./job-menu";

export interface JobHeaderSimpleProps {
  page: SimpleJobPage;
  timeZone: string;
  /** Where "Back" goes (Jobs for photographers, My jobs for editors). */
  backHref: string;
  backLabel: string;
  className?: string;
}

/**
 * Header (plan §5): address / job name · client · type of shoot · stage pill ·
 * "Waiting on: Sam" · due chip · Round N · Rush · "Shot by Mo · Edited by Sam" ·
 * the job number in small grey text. The ⋯ menu sits on the right.
 */
export function JobHeaderSimple({ page, timeZone, backHref, backLabel, className }: JobHeaderSimpleProps) {
  const { header } = page;
  const people = [header.shotBy ? `Shot by ${header.shotBy.name}` : null, header.editedBy ? `Edited by ${header.editedBy.name}` : null].filter(Boolean).join(" · ");
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      <Link href={backHref} className="inline-flex w-fit items-center gap-1 text-sm text-ink-muted hover:text-ink focus-ring rounded-xs">
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        {backLabel}
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
            <span className="font-medium text-ink-secondary">{header.client.name}</span>
            <span aria-hidden="true">·</span>
            <span>{header.jobTypeName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-xs numeric">{header.jobNumber}</span>
          </p>
          <h1 className="mt-0.5 text-2xl font-semibold leading-8 text-ink break-words">{header.name}</h1>
        </div>
        <JobMenu page={page} timeZone={timeZone} className="shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StagePill display={header.stage} size="md" hideSubLabel={header.stage.subLabel === "round"} />
        {header.waitingOn ? (
          <span className={cn("inline-flex items-center gap-1 text-sm", header.waitingOn === "You" ? "font-medium text-attention-fg" : "text-ink-secondary")}>
            <span className="text-ink-muted">Waiting on:</span>
            <span>{header.waitingOn}</span>
          </span>
        ) : null}
        <SimpleDueChip due={header.due} active={header.stage.active} />
        <RoundBadge round={header.round} />
        <RushBadge rush={header.rush} />
      </div>
      {people ? <p className="text-sm text-ink-muted">{people}</p> : null}
    </header>
  );
}
