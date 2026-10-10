import type { Metadata } from "next";
import Link from "next/link";
import { Camera, Check, Minus, Store, Wand2, X } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { PermissionSwitches } from "@/components/settings/permission-switches";
import { PERSONA_BADGE } from "@/components/settings/permission-copy";
import { PageContainer } from "@/components/shell/page-container";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  EDITOR_FLAG_META,
  EDITOR_INVITE_DEFAULTS,
  MEMBER_FLAG_META,
  MEMBER_INVITE_DEFAULTS,
  PERSONAS,
  PERSONA_LABELS,
  type Persona,
} from "@/lib/constants";
import type { PermissionMatrixCell, PermissionMatrixRow, ReducedUser, UserProfile } from "@/lib/types";
import { getPermissionMatrix, getSettingsView } from "@/server/queries/settings";
import { listUsers } from "@/server/queries/users";
import { guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Roles & permissions" };

/** Action groups of the matrix, in reading order. */
const AREAS: { id: string; label: string; description: string; prefixes: string[] }[] = [
  { id: "access", label: "Getting in", description: "Who uses the studio app, who uses the client portal, and the personal / business view.", prefixes: ["app.", "portal.access", "view."] },
  { id: "jobs", label: "Jobs & workflow", description: "Creating, editing, assigning, reviewing and delivering jobs.", prefixes: ["job."] },
  {
    id: "collab",
    label: "Revisions, links, notes & comments",
    description: "Collaboration on a job, including what is shared with the client.",
    prefixes: ["revision.", "link.", "note.", "comment.", "client_feedback."],
  },
  { id: "time", label: "Time tracking", description: "Timers and session history.", prefixes: ["timer."] },
  {
    id: "insights",
    label: "Workloads, analytics & reports",
    description: "Aggregates and performance data.",
    prefixes: ["analytics.", "workloads.", "performance.", "bottlenecks.", "reports.", "export."],
  },
  { id: "people", label: "People & teams", description: "Users, admins, the primary owner, teams and the directory.", prefixes: ["user.", "team.", "org."] },
  { id: "production", label: "Clients & projects", description: "The Client → Project structure and the client portal switches.", prefixes: ["client.", "project."] },
  { id: "portal", label: "Client portal", description: "What client users can do with work you share.", prefixes: ["portal."] },
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
  // Longest matching prefix wins ("portal.access" before "portal.").
  let best: { id: string; len: number } | null = null;
  for (const a of AREAS) {
    for (const p of a.prefixes) {
      if (action.startsWith(p) && (!best || p.length > best.len)) best = { id: a.id, len: p.length };
    }
  }
  return best?.id ?? "admin";
}

/** Column headings: Owner / Photographer · Photographer (team member) · Editor · Client (docs/ROLES.md §11). */
const COLUMN_LABEL: Record<Persona, string> = PERSONA_LABELS;

function needsLabel(cell: PermissionMatrixCell): string | null {
  if (cell.memberFlag) return MEMBER_FLAG_META[cell.memberFlag].label;
  if (cell.editorFlag) return EDITOR_FLAG_META[cell.editorFlag].label;
  return null;
}

function Cell({ cell }: { cell: PermissionMatrixCell }) {
  const needs = needsLabel(cell);
  if (!cell.allowed) {
    return (
      <span className="inline-flex items-center gap-1 text-ink-subtle" title="Never">
        <X aria-hidden="true" className="size-3.5" />
        <span className="sr-only">Never</span>
      </span>
    );
  }
  if (cell.scope === "any" && !needs) {
    return (
      <span className="inline-flex items-center gap-1 text-success" title="Always">
        <Check aria-hidden="true" className="size-4" />
        <span className="sr-only">Always</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-start gap-1.5 text-attention-fg">
        <Minus aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
        <span className="text-xs leading-snug">{cell.scope === "any" ? "any job" : cell.scope}</span>
      </span>
      {needs ? (
        <Badge variant="outline" size="sm" title={`Needs the “${needs}” switch`}>
          needs: {needs}
        </Badge>
      ) : null}
    </span>
  );
}

function RoleCard({ icon: Icon, title, badge, children }: { icon: typeof Camera; title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-ink-subtle" />
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {badge}
      </div>
      <div className="flex flex-col gap-3 text-sm text-ink-secondary">{children}</div>
    </div>
  );
}

function Lines({ label, items, tone }: { label: string; items: string[]; tone: "can" | "cannot" | "sees" }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {items.map((i) => (
          <li key={i} className="flex gap-1.5">
            {tone === "cannot" ? (
              <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
            ) : (
              <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
            )}
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function RolesSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const rows = await load(() => getPermissionMatrix(ctx));
  const grouped = AREAS.map((area) => ({ area, rows: rows.filter((r) => areaOf(r.action) === area.id) })).filter((g) => g.rows.length > 0);

  const settings = (await load(() => getSettingsView(db, ctx))).settings;
  const photographers = (await load(() => listUsers(db, ctx, { role: "photographer" }))) as (UserProfile | ReducedUser)[];
  const byId = new Map(photographers.map((p) => [p.id, p]));
  const configured = settings.defaultPhotographerUserId ? byId.get(settings.defaultPhotographerUserId) : undefined;
  const primary = settings.primaryOwnerUserId ? byId.get(settings.primaryOwnerUserId) : undefined;
  const defaultPhotographer = configured && configured.isActive ? configured : primary;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="Roles"
        description="Three roles: Photographer, Editor and Client. You are a Photographer with admin. Photographers you invite are team members whose switches you control."
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Check aria-hidden="true" className="size-4 text-success" /> Always
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Minus aria-hidden="true" className="size-3.5 text-attention" /> Conditional (scope shown; “needs:” = the switch it takes)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <X aria-hidden="true" className="size-3.5 text-ink-subtle" /> Never
          </span>
        </div>
      </PageHeader>

      <div className="grid gap-3 lg:grid-cols-3">
        <RoleCard icon={Camera} title="Photographer">
          <div className="rounded-md border border-border p-3">
            <Badge variant={PERSONA_BADGE.admin} size="sm">
              {PERSONA_LABELS.admin}
            </Badge>
            <p className="mt-1.5">
              Runs the business and shoots. Sees every job, person, number and setting, reviews and delivers, with a{" "}
              <span className="font-medium text-ink">My shoots | Whole business</span> switch instead of a second account. Admin is a switch on a
              photographer; the primary owner can&apos;t be demoted by other admins.
            </p>
          </div>
          <div className="rounded-md border border-border p-3">
            <Badge variant={PERSONA_BADGE.member} size="sm">
              {PERSONA_LABELS.member}
            </Badge>
            <p className="mt-1.5">
              Other photographers you invite. Always see their own jobs and the jobs you assign to them; everything else is a switch you control
              (below). Never admin unless you make them one.
            </p>
          </div>
        </RoleCard>

        <RoleCard
          icon={Wand2}
          title="Editor"
          badge={
            <Badge variant={PERSONA_BADGE.editor} size="sm">
              {PERSONA_LABELS.editor}
            </Badge>
          }
        >
          <Lines
            label="Can"
            tone="can"
            items={[
              "See jobs assigned to them, with the brief, deadlines and priority",
              "Accept, start, pause, add notes, comments and questions",
              "Add finished-work links, submit, respond to revisions, resubmit",
              "See their own completed jobs and work history",
              "Create jobs for a photographer (“Create jobs” switch, on by default)",
            ]}
          />
          <Lines
            label="Can't"
            tone="cannot"
            items={[
              "Manage settings or people, or reassign other editors",
              "Approve their own work, delete jobs or touch the audit log",
              "See internal or client notes, emails, or studio-wide numbers",
              "See other editors' jobs — unless “See other editors' jobs” is on",
            ]}
          />
        </RoleCard>

        <RoleCard
          icon={Store}
          title="Client"
          badge={
            <Badge variant={PERSONA_BADGE.client} size="sm">
              {PERSONA_LABELS.client} · optional
            </Badge>
          }
        >
          <Lines
            label="Sees"
            tone="sees"
            items={[
              "Only jobs and projects you share with their client",
              "Milestones (Booked → Shot → Editing → Delivered) and the agreed dates",
              "Finished-work links you share, delivery notes",
              "Leaves feedback when you allow it for that client",
            ]}
          />
          <Lines
            label="Never"
            tone="cannot"
            items={[
              "Internal notes, editor discussions or revision details",
              "Staff workloads, other clients or the activity log",
              "Assigning editors, changing stages, unpublished work",
            ]}
          />
          <p className="text-xs text-ink-muted">Turn the portal on per client from the client&apos;s page, then invite their people from Users.</p>
        </RoleCard>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <SectionCard title="Team-member switches" description="What a photographer team member can do. New invites start with the defaults shown; you change them per person under Users.">
          <PermissionSwitches kind="member" values={MEMBER_INVITE_DEFAULTS} readOnly aria-label="Team-member switches (invite defaults)" />
        </SectionCard>
        <div className="flex flex-col gap-3">
          <SectionCard title="Editor switches" description="Per editor, under Users. Defaults for new invites shown.">
            <PermissionSwitches kind="editor" values={EDITOR_INVITE_DEFAULTS} readOnly aria-label="Editor switches (invite defaults)" />
          </SectionCard>
          <SectionCard title="Jobs editors create">
            <p className="text-sm text-ink-secondary">
              Default photographer for jobs editors create:{" "}
              <span className="font-medium text-ink">{defaultPhotographer?.name ?? "the primary owner"}</span>
              {configured ? null : " (the primary owner)"}.{" "}
              <Link href="/settings/organisation" className="font-medium text-accent-ink hover:underline">
                Change in Settings → Organisation
              </Link>
            </p>
          </SectionCard>
        </div>
      </div>

      {grouped.map(({ area, rows: areaRows }) => (
        <SectionCard key={area.id} id={`area-${area.id}`} title={area.label} description={area.description} flush>
          {/* Desktop matrix */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface-sunken text-left text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="w-[28%] px-5 py-2.5">
                    Action
                  </th>
                  {PERSONAS.map((p) => (
                    <th key={p} scope="col" className="px-3 py-2.5">
                      {COLUMN_LABEL[p]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {areaRows.map((row: PermissionMatrixRow) => (
                  <tr key={row.action} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                    <th scope="row" className="px-5 py-2.5 text-left align-top font-normal">
                      <span className="block text-ink">{row.label}</span>
                      <code className="font-mono text-2xs text-ink-subtle">{row.action}</code>
                    </th>
                    {PERSONAS.map((p) => (
                      <td key={p} className="px-3 py-2.5 align-top">
                        <Cell cell={row.cells[p]} />
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
                <dl className="mt-2 flex flex-col gap-1.5">
                  {PERSONAS.map((p) => (
                    <div key={p} className="flex min-w-0 items-start gap-2">
                      <dt className="w-28 shrink-0 text-xs text-ink-muted">{COLUMN_LABEL[p]}</dt>
                      <dd className="min-w-0">
                        <Cell cell={row.cells[p]} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          {area.id === "jobs" ? (
            <p className="border-t border-border px-5 py-3 text-xs text-ink-muted">
              Team members can cancel or re-date jobs someone else assigned to them only with Review submissions. Nobody can review, approve or deliver a job
              they edited.
            </p>
          ) : null}
        </SectionCard>
      ))}
    </PageContainer>
  );
}
