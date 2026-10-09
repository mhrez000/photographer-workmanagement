import type { Metadata } from "next";
import { Check, Eye, Minus, X } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { PageContainer } from "@/components/shell/page-container";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants";
import type { PermissionMatrixRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getPermissionMatrix } from "@/server/queries/settings";
import { guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Roles & permissions" };

const AREAS: { id: string; label: string; description: string; prefixes: string[] }[] = [
  { id: "jobs", label: "Jobs & workflow", description: "Creating, editing and moving jobs through the workflow.", prefixes: ["job."] },
  { id: "collab", label: "Revisions, links, notes & comments", description: "Collaboration on a job.", prefixes: ["revision.", "link.", "note.", "comment."] },
  { id: "time", label: "Time tracking", description: "Timers and session history.", prefixes: ["timer."] },
  {
    id: "insights",
    label: "Workloads, analytics & reports",
    description: "Aggregates and performance data.",
    prefixes: ["analytics.", "workloads.", "performance.", "bottlenecks.", "reports.", "export."],
  },
  { id: "people", label: "People & teams", description: "Users, teams and the directory.", prefixes: ["user.", "team."] },
  { id: "production", label: "Clients & projects", description: "The Client → Project structure.", prefixes: ["client.", "project."] },
  { id: "activity", label: "Activity & search", description: "The audit feed and global search.", prefixes: ["activity.", "search."] },
  {
    id: "admin",
    label: "Studio administration",
    description: "Settings, workflows, job types, automations and system tools.",
    prefixes: ["settings.", "workflow.", "job_type.", "automation.", "system."],
  },
  { id: "personal", label: "Personal", description: "Your own notifications, views and dashboard.", prefixes: ["notification.", "saved_view.", "dashboard."] },
];

function areaOf(action: string): string {
  return AREAS.find((a) => a.prefixes.some((p) => action.startsWith(p)))?.id ?? "admin";
}

const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Everything, including org settings, workflows and anonymising people.",
  manager: "Team, production and analytics. Read-only on org settings and workflows; manages photographers and editors only.",
  photographer: "Own jobs plus team visibility per settings. Reviews, approves and requests revisions on their work.",
  editor: "Assigned jobs only. Starts, pauses, submits and resubmits; past jobs stay read-only.",
};

function Cell({ cell }: { cell: PermissionMatrixRow["cells"][Role] }) {
  if (!cell.allowed) {
    return (
      <span className="inline-flex items-center gap-1 text-ink-subtle" title="Never">
        <X aria-hidden="true" className="size-3.5" />
        <span className="sr-only">Never</span>
      </span>
    );
  }
  if (cell.scope === "any") {
    return (
      <span className="inline-flex items-center gap-1 text-success" title="Always">
        <Check aria-hidden="true" className="size-4" />
        <span className="sr-only">Always</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 text-attention-fg">
      <Minus aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
      <span className="text-xs leading-snug">{cell.scope}</span>
    </span>
  );
}

export default async function RolesSettingsPage() {
  const { ctx } = await pageContext();
  guard(ctx, "settings.view");
  const rows = load(() => getPermissionMatrix(ctx));
  const grouped = AREAS.map((area) => ({ area, rows: rows.filter((r) => areaOf(r.action) === area.id) })).filter((g) => g.rows.length > 0);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="Roles"
        description="What each role can see and do. Rules are enforced on the server for every request — hiding a button is never the boundary."
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Check aria-hidden="true" className="size-4 text-success" /> Always
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Minus aria-hidden="true" className="size-3.5 text-attention" /> Conditional (scope shown)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <X aria-hidden="true" className="size-3.5 text-ink-subtle" /> Never
          </span>
        </div>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((role) => (
          <div key={role} className="rounded-lg border border-border bg-surface p-4 shadow-xs">
            <Badge variant={role === "owner" ? "solid" : role === "manager" ? "accent" : role === "photographer" ? "info" : "neutral"}>{ROLE_LABELS[role]}</Badge>
            <p className="mt-2 text-sm text-ink-secondary">{ROLE_SUMMARY[role]}</p>
          </div>
        ))}
      </div>

      <SectionCard
        title="Extra visibility"
        description="Two switches widen what photographers and editors see without changing their role."
        actions={<Eye aria-hidden="true" className="size-4 text-ink-subtle" />}
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-ink">Per photographer (Users → person)</dt>
            <dd className="mt-1 text-ink-muted">
              <span className="font-medium text-ink-secondary">Can view team workloads</span> shows editor workload aggregates — counts and bands, never job
              details. <span className="font-medium text-ink-secondary">Can view analytics</span> opens Insights: analytics, bottlenecks, reports and CSV export.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink">Studio-wide (Organisation → Visibility)</dt>
            <dd className="mt-1 text-ink-muted">
              Photographers can see all jobs or their team’s jobs; editors can see their team’s jobs (read-only) and team workloads. Teams are defined under
              Settings → Teams.
            </dd>
          </div>
        </dl>
      </SectionCard>

      {grouped.map(({ area, rows: areaRows }) => (
        <SectionCard key={area.id} id={`area-${area.id}`} title={area.label} description={area.description} flush>
          {/* Desktop matrix */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface-sunken text-left text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="w-[34%] px-5 py-2.5">
                    Action
                  </th>
                  {ROLES.map((r) => (
                    <th key={r} scope="col" className="px-3 py-2.5">
                      {ROLE_LABELS[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {areaRows.map((row) => (
                  <tr key={row.action} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                    <th scope="row" className="px-5 py-2.5 text-left align-top font-normal">
                      <span className="block text-ink">{row.label}</span>
                      <code className="font-mono text-2xs text-ink-subtle">{row.action}</code>
                    </th>
                    {ROLES.map((r) => (
                      <td key={r} className="px-3 py-2.5 align-top">
                        <Cell cell={row.cells[r]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile: one card per action */}
          <ul className="divide-y divide-border md:hidden">
            {areaRows.map((row) => (
              <li key={row.action} className="px-4 py-3">
                <p className="text-sm font-medium text-ink">{row.label}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {ROLES.map((r) => (
                    <div key={r} className={cn("flex min-w-0 items-start gap-2")}>
                      <dt className="w-20 shrink-0 text-xs text-ink-muted">{ROLE_LABELS[r]}</dt>
                      <dd className="min-w-0">
                        <Cell cell={row.cells[r]} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </SectionCard>
      ))}
    </PageContainer>
  );
}
