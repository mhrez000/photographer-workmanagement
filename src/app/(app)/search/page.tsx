import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Briefcase,
  Building2,
  FolderOpen,
  History,
  MessageSquare,
  NotebookPen,
  Search as SearchIcon,
  SearchX,
  Users,
  type LucideIcon,
} from "lucide-react";
import { PageContainer } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ModKbd } from "@/components/ui/mod-kbd";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/jobs/status-pill";
import { Highlight } from "@/components/production/highlight";
import { UrlSearchInput } from "@/components/production/url-search";
import { ROLE_LABELS } from "@/lib/constants";
import type { SearchResults } from "@/lib/types";
import { isManagement } from "@/server/auth/permissions";
import { guard, load, pageContext, param } from "@/server/page";
import { globalSearch } from "@/server/queries/search";

export const metadata: Metadata = { title: "Search" };

const SEARCH_PAGE_LIMIT = 25;

type JobHit = SearchResults["jobs"][number];

const MATCH_LABEL: Record<JobHit["matchedIn"], string> = {
  number: "Job number",
  name: "Job name",
  description: "Description",
  note: "Note",
  comment: "Comment",
  status: "Status",
};

function Group({ id, title, icon: Icon, count, children }: { id: string; title: string; icon: LucideIcon; count: number; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h2 id={`${id}-title`} className="flex items-center gap-2 px-1 text-xs font-semibold text-ink-secondary">
        <Icon aria-hidden="true" className="size-3.5 text-ink-muted" />
        {title}
        <span className="font-normal text-ink-subtle numeric">{count}</span>
      </h2>
      <Card flush className="overflow-hidden">
        <ul className="divide-y divide-border">{children}</ul>
      </Card>
    </section>
  );
}

function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="group flex min-h-12 items-center gap-3 px-4 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted focus-visible:bg-surface-muted focus-ring"
      >
        {children}
        <ArrowRight aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </Link>
    </li>
  );
}

function JobRowLink({ job, q, showMatch, tab }: { job: JobHit; q: string; showMatch?: boolean; tab?: "notes" | "comments" }) {
  return (
    <RowLink href={tab ? `/jobs/${job.id}?tab=${tab}` : `/jobs/${job.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Highlight text={job.jobNumber} query={q} className="shrink-0 font-mono text-xs text-ink-muted numeric" />
          <Highlight text={job.name} query={q} className="truncate text-sm font-medium text-ink" />
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-ink-muted">
          <span className="truncate">{job.client.name}</span>
          {showMatch ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">Matched in {MATCH_LABEL[job.matchedIn].toLowerCase()}</span>
            </>
          ) : null}
        </div>
      </div>
      <StatusPill status={job.status} size="sm" className="shrink-0" />
    </RowLink>
  );
}

function Tips() {
  return (
    <ul className="mx-auto mt-2 grid max-w-xl gap-2 text-left text-sm text-ink-secondary sm:grid-cols-2">
      <li className="rounded-md border border-border bg-surface px-3 py-2">
        Try a job number like <span className="font-mono text-ink">PJ-0042</span> — or just <span className="font-mono text-ink">42</span>
      </li>
      <li className="rounded-md border border-border bg-surface px-3 py-2">Search a street address, client or project</li>
      <li className="rounded-md border border-border bg-surface px-3 py-2">Find a photographer or editor by name</li>
      <li className="rounded-md border border-border bg-surface px-3 py-2">Words inside notes and comments are searched too</li>
    </ul>
  );
}

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "search.global");
  const sp = await searchParams;
  const q = (param(sp, "q") ?? "").trim();
  const results = q ? await load(() => globalSearch(db, ctx, q, { limit: SEARCH_PAGE_LIMIT })) : null;

  const exact = results?.exactJob ? results.jobs.find((j) => j.id === results.exactJob?.id) ?? null : null;
  const jobs = results?.jobs.filter((j) => j.id !== exact?.id && (j.matchedIn === "number" || j.matchedIn === "name" || j.matchedIn === "description" || j.matchedIn === "status")) ?? [];
  const noteJobs = results?.jobs.filter((j) => j.id !== exact?.id && j.matchedIn === "note") ?? [];
  const commentJobs = results?.jobs.filter((j) => j.id !== exact?.id && j.matchedIn === "comment") ?? [];
  const total = results ? results.jobs.length + results.clients.length + results.projects.length + results.users.length : 0;
  const management = isManagement(ctx);

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Search"
        title={q ? <>Results for “{q}”</> : "Search everything"}
        description={
          q ? (
            <span className="numeric">
              {total === 0 ? "No matches" : `${total}${total >= SEARCH_PAGE_LIMIT ? "+" : ""} match${total === 1 ? "" : "es"}`} across jobs, clients, projects and people.
            </span>
          ) : (
            "Jobs, clients, projects, people, notes and comments — only what you're allowed to see."
          )
        }
      >
        <UrlSearchInput placeholder="Job number, address, client, person…" label="Search" autoFocus={!q} size="lg" />
        <p className="hidden text-xs text-ink-subtle sm:block">
          Tip: press <ModKbd keys={["K"]} /> anywhere to search without leaving the page.
        </p>
      </PageHeader>

      {!q ? (
        <EmptyState icon={SearchIcon} title="What are you looking for?" description="Start typing above. Exact job numbers jump straight to the job." action={<Tips />} />
      ) : total === 0 ? (
        <EmptyState
          icon={SearchX}
          title={`Nothing found for “${q}”`}
          description="Check the spelling, try fewer words, or search by job number."
          action={<Tips />}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {exact ? (
            <Card tone="accent" className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant="accent">
                    Exact job number
                  </Badge>
                  <StatusPill status={exact.status} size="sm" />
                </div>
                <Link href={`/jobs/${exact.id}`} className="mt-1.5 block min-w-0 rounded-xs focus-ring">
                  <span className="font-mono text-sm text-ink-muted numeric">{exact.jobNumber}</span>{" "}
                  <span className="text-md font-semibold text-ink hover:underline">{exact.name}</span>
                </Link>
                <p className="mt-0.5 text-sm text-ink-muted">{exact.client.name}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button href={`/jobs/${exact.id}`} variant="outline" size="sm">
                  Open job
                </Button>
                <Button href={`/jobs/${exact.id}?tab=history`} size="sm" leadingIcon={<History aria-hidden="true" />}>
                  Open full history
                </Button>
              </div>
            </Card>
          ) : null}

          {jobs.length > 0 ? (
            <Group id="jobs" title="Jobs" icon={Briefcase} count={jobs.length}>
              {jobs.map((j) => (
                <JobRowLink key={j.id} job={j} q={q} showMatch={j.matchedIn === "description" || j.matchedIn === "status"} />
              ))}
            </Group>
          ) : null}

          {results && results.clients.length > 0 ? (
            <Group id="clients" title="Clients" icon={Building2} count={results.clients.length}>
              {results.clients.map((c) => (
                <RowLink key={c.id} href={`/clients/${c.id}`}>
                  <Avatar name={c.name} size="sm" shape="rounded" />
                  <Highlight text={c.name} query={q} className="truncate text-sm font-medium text-ink" />
                </RowLink>
              ))}
            </Group>
          ) : null}

          {results && results.projects.length > 0 ? (
            <Group id="projects" title="Projects" icon={FolderOpen} count={results.projects.length}>
              {results.projects.map((p) => (
                <RowLink key={p.id} href={`/projects/${p.id}`}>
                  <div className="min-w-0">
                    <Highlight text={p.name} query={q} className="block truncate text-sm font-medium text-ink" />
                    <span className="block truncate text-xs text-ink-muted">{p.client.name}</span>
                  </div>
                </RowLink>
              ))}
            </Group>
          ) : null}

          {results && results.users.length > 0 ? (
            <Group id="people" title="People" icon={Users} count={results.users.length}>
              {results.users.map((u) => {
                const body = (
                  <>
                    <Avatar name={u.name} colour={u.avatarColour} size="sm" />
                    <Highlight text={u.name} query={q} className="truncate text-sm font-medium text-ink" />
                    <span className="text-xs text-ink-muted">{ROLE_LABELS[u.role]}</span>
                  </>
                );
                return management || u.id === ctx.userId ? (
                  <RowLink key={u.id} href={`/team/users/${u.id}`}>
                    {body}
                  </RowLink>
                ) : (
                  <li key={u.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                    {body}
                  </li>
                );
              })}
            </Group>
          ) : null}

          {noteJobs.length > 0 ? (
            <Group id="notes" title="Notes" icon={NotebookPen} count={noteJobs.length}>
              {noteJobs.map((j) => (
                <JobRowLink key={j.id} job={j} q={q} showMatch tab="notes" />
              ))}
            </Group>
          ) : null}

          {commentJobs.length > 0 ? (
            <Group id="comments" title="Comments" icon={MessageSquare} count={commentJobs.length}>
              {commentJobs.map((j) => (
                <JobRowLink key={j.id} job={j} q={q} showMatch tab="comments" />
              ))}
            </Group>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
