import * as React from "react";
import { PageContainer } from "@/components/shell/page-container";
import { Skeleton, SkeletonTable, SkeletonText } from "@/components/ui/skeleton";

function HeaderSkeleton({ actions = false }: { actions?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {actions ? <Skeleton className="hidden h-9 w-32 sm:block" /> : null}
    </div>
  );
}

function SectionSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5 shadow-xs">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Narrow page of form sections (organisation, profile, user detail…). */
export function SettingsFormSkeleton({ sections = 3, actions = false }: { sections?: number; actions?: boolean }) {
  return (
    <PageContainer width="narrow" aria-busy="true" aria-label="Loading">
      <HeaderSkeleton actions={actions} />
      {Array.from({ length: sections }, (_, i) => (
        <SectionSkeleton key={i} fields={i === 0 ? 4 : 2} />
      ))}
    </PageContainer>
  );
}

/** Toolbar + table (users, roles). */
export function SettingsTableSkeleton({ narrow = false, rows = 8, columns = 6 }: { narrow?: boolean; rows?: number; columns?: number }) {
  return (
    <PageContainer width={narrow ? "narrow" : "default"} aria-busy="true" aria-label="Loading">
      <HeaderSkeleton actions />
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-full sm:w-72" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-8 w-52" />
      </div>
      <SkeletonTable rows={rows} columns={columns} />
    </PageContainer>
  );
}

/** List of cards (teams, workflows, automations, job types). */
export function SettingsListSkeleton({ narrow = true, count = 4, grid = false }: { narrow?: boolean; count?: number; grid?: boolean }) {
  return (
    <PageContainer width={narrow ? "narrow" : "default"} aria-busy="true" aria-label="Loading">
      <HeaderSkeleton actions />
      <div className={grid ? "grid gap-4 xl:grid-cols-2" : "flex flex-col gap-3"}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-5 shadow-xs">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-md" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            </div>
            {grid ? <SkeletonText lines={3} className="mt-4" /> : null}
          </div>
        ))}
      </div>
    </PageContainer>
  );
}

/** Workflow editor: validation banner, statuses list, matrix. */
export function WorkflowEditorSkeleton() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading">
      <HeaderSkeleton actions />
      <Skeleton className="h-12 w-full rounded-lg" />
      <div className="rounded-lg border border-border bg-surface shadow-xs">
        <div className="p-5">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="divide-y divide-border border-t border-border">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-4" />
              <Skeleton className="size-3 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
      <Skeleton className="h-72 w-full rounded-lg" />
    </PageContainer>
  );
}
