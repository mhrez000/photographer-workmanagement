import type { Metadata } from "next";
import { BookOpen, Keyboard, ShieldCheck, Workflow } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { CategoryPill, StatusPill } from "@/components/jobs/status-pill";
import { CATEGORY_MEANING } from "@/components/settings/category-meaning";
import { PageContainer } from "@/components/shell/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PageHeader } from "@/components/ui/page-header";
import { DEFAULT_WORKFLOW_STATUSES, KEYBOARD_SHORTCUTS, PERSONAS, PERSONA_LABELS, type Persona } from "@/lib/constants";
import { personaOf } from "@/server/auth/permissions";
import { allowed, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Help & shortcuts" };

const SCOPE_LABEL = { global: "Anywhere", list: "Lists & tables", job: "On a job" } as const;

/** One card per persona (docs/ROLES.md §0): three roles, admin is a switch on a photographer. */
const ROLE_HELP: Record<Persona, { summary: string; can: string[] }> = {
  admin: {
    summary: "Runs the business and shoots. A photographer with admin.",
    can: [
      "Every job, person, number and setting — switch between My shoots and Whole business",
      "Create jobs for any photographer, assign editors, review, approve and deliver",
      "Invite photographers, editors and client users; set each person's switches",
    ],
  },
  member: {
    summary: "Another photographer on the team. The owner chooses what else they can do.",
    can: [
      "Always: their own jobs and jobs where they are the photographer",
      "With switches: create jobs, assign editors, review submissions",
      "With switches: see all jobs, team workload, analytics",
    ],
  },
  editor: {
    summary: "A focused queue of assigned work.",
    can: [
      "Accept, start, pause, submit and resubmit assigned jobs",
      "Add finished-work links, notes, comments and questions",
      "Create jobs for a photographer (when the studio allows it)",
    ],
  },
  client: {
    summary: "Optional portal for the studio's clients.",
    can: ["Sees only work shared with their client", "Milestones, delivered links and delivery notes", "Leaves feedback when the studio allows it"],
  },
};

/** Renders "mod+k" / "g d" / "j / k" with Kbd chips. */
function Keys({ spec }: { spec: string }) {
  const groups = spec.split(" / ");
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {groups.map((group, gi) => (
        <span key={gi} className="inline-flex items-center gap-1">
          {gi > 0 ? <span className="text-xs text-ink-subtle">/</span> : null}
          {group.split(" ").map((chord, ci) => (
            <span key={ci} className="inline-flex items-center gap-1">
              {ci > 0 ? <span className="text-2xs text-ink-subtle">then</span> : null}
              <Kbd keys={chord.split("+").map((k) => (k === "mod" ? "⌘/Ctrl" : k === "enter" ? "Enter" : k === "esc" ? "Esc" : k.toUpperCase()))} />
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export default async function HelpPage() {
  const { ctx } = await pageContext();
  const scopes = (["global", "list", "job"] as const).map((scope) => ({ scope, items: KEYBOARD_SHORTCUTS.filter((s) => s.scope === scope) }));
  const canSeeRoles = allowed(ctx, "settings.view");
  const me = personaOf(ctx);

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Help"
        title="Help & shortcuts"
        description="Move faster with the keyboard, and a quick reference for statuses and roles."
        actions={
          canSeeRoles ? (
            <Button variant="outline" size="sm" href="/settings/roles" leadingIcon={<ShieldCheck aria-hidden="true" />}>
              Full permission matrix
            </Button>
          ) : undefined
        }
      >
        <nav aria-label="On this page" className="flex flex-wrap gap-1.5">
          {[
            ["shortcuts", "Keyboard shortcuts"],
            ["statuses", "Statuses"],
            ["roles", "Roles"],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary hover:border-border-hover hover:text-ink focus-ring"
            >
              {label}
            </a>
          ))}
        </nav>
      </PageHeader>

      <SectionCard
        id="shortcuts"
        title="Keyboard shortcuts"
        description={
          <>
            Press <Kbd>?</Kbd> anywhere to see these. Shortcuts pause while you’re typing in a field.
          </>
        }
        actions={<Keyboard aria-hidden="true" className="size-4 text-ink-subtle" />}
        flush
      >
        <div className="divide-y divide-border">
          {scopes.map(({ scope, items }) => (
            <div key={scope} className="px-5 py-4">
              <h3 className="eyebrow mb-2">{SCOPE_LABEL[scope]}</h3>
              <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                {items.map((s) => (
                  <div key={s.keys} className="flex items-center justify-between gap-4 py-0.5">
                    <dt className="text-sm text-ink-secondary">{s.description}</dt>
                    <dd className="shrink-0">
                      <Keys spec={s.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        id="statuses"
        title="Status glossary"
        description="The standard workflow. Studios can rename or add statuses, but each one maps to one of these categories — that's what dashboards, boards and automations understand."
        actions={<Workflow aria-hidden="true" className="size-4 text-ink-subtle" />}
        flush
      >
        <ol className="divide-y divide-border">
          {DEFAULT_WORKFLOW_STATUSES.map((s, i) => (
            <li key={s.key} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
              <span className="flex w-56 shrink-0 items-center gap-2">
                <span className="w-5 text-right text-xs text-ink-subtle numeric">{i + 1}</span>
                <StatusPill status={{ name: s.name, category: s.category, colour: s.colour }} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm text-ink-secondary">{CATEGORY_MEANING[s.category]}</span>
                {s.name.toLowerCase() !== s.category.replace("_", " ") ? (
                  <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                    Category <CategoryPill category={s.category} size="xs" />
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard
        id="roles"
        title="Roles"
        description="Three roles — Photographer, Editor and Client. The studio owner is a photographer with admin; other photographers are team members."
        actions={<BookOpen aria-hidden="true" className="size-4 text-ink-subtle" />}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {PERSONAS.map((r) => (
            <div key={r} className="rounded-lg border border-border bg-surface-sunken/60 p-4">
              <div className="flex items-center gap-2">
                <Badge variant={r === me ? "accent" : "outline"}>{PERSONA_LABELS[r]}</Badge>
                {r === me ? <span className="text-xs text-ink-muted">You</span> : null}
              </div>
              <p className="mt-2 text-sm font-medium text-ink">{ROLE_HELP[r].summary}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
                {ROLE_HELP[r].can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-ink-muted">
          Every change is recorded in the activity log with who, what, when, before and after — history can’t be edited or deleted.
        </p>
      </SectionCard>
    </PageContainer>
  );
}
