import type { Metadata } from "next";
import { CalendarRange, LayoutList, Plus, Sparkles } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueueSection, RunningTimerBanner, SummaryStrip, WorkCard, perspectiveOf, sectionsFor, type MyWorkSectionKey } from "@/components/my-work";
import { getViewer } from "@/server/auth/session";
import { allowed, load, pageContext } from "@/server/page";
import { getMyWorkNotePreviews, getMyWorkQueue } from "@/server/queries/myWork";
import { runningSessionFor } from "@/server/services/timeTracking";
import { pluralise } from "@/lib/utils";

export const metadata: Metadata = { title: "My Work" };

function greeting(timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date()));
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone }).format(new Date());
}

/**
 * My Work (spec §2 editor workspace, §7, ARCHITECTURE §10): the viewer's
 * focused queue. Editors see the jobs they hold; photographers (the owner
 * included) see their own jobs, with the Review queue first. My Work is always
 * personal — the My shoots | Whole business switch does not apply (docs/ROLES.md §8).
 */
export default async function MyWorkPage() {
  const { ctx, db } = await pageContext();
  const viewer = await getViewer();
  const tz = ctx.settings.timezone;
  const queue = await load(() => getMyWorkQueue(db, ctx));
  const running = await load(() => runningSessionFor(db, ctx));

  const perspective = perspectiveOf(ctx.role);
  const sections = sectionsFor(perspective);
  const counts = Object.fromEntries(sections.map((s) => [s.key, queue[s.key].length])) as Record<MyWorkSectionKey, number>;
  const allJobs = sections.flatMap((s) => queue[s.key]);
  const notes = await load(() => getMyWorkNotePreviews(db, ctx, allJobs.map((j) => j.id)));
  const total = allJobs.length;
  const canCreate = allowed(ctx, "job.create");
  const viewerRef = { id: ctx.userId ?? "", role: ctx.role };
  const firstName = viewer?.name.split(/\s+/)[0];

  const focus: string[] = [];
  if (counts.overdue > 0) focus.push(`${counts.overdue} overdue`);
  if (counts.dueToday > 0) focus.push(`${counts.dueToday} due today`);
  if (perspective === "reviewer" && counts.waitingForReview > 0) focus.push(`${counts.waitingForReview} to review`);
  if (perspective === "editor" && counts.revisionRequired > 0) focus.push(`${pluralise(counts.revisionRequired, "revision")} to fix`);
  const description =
    total === 0
      ? "Your queue is clear."
      : `${pluralise(total, "active job")} in your queue${focus.length > 0 ? ` — ${focus.join(", ")}.` : "."}`;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={todayLabel(tz)}
        title={firstName ? `${greeting(tz)}, ${firstName}` : "My Work"}
        description={description}
        actions={
          <>
            <Button href="/workspace/calendar" variant="outline" leadingIcon={<CalendarRange />} className="hidden sm:inline-flex">
              Calendar
            </Button>
            {canCreate ? (
              <Button href="/jobs/new" leadingIcon={<Plus />}>
                New job
              </Button>
            ) : null}
          </>
        }
      />

      {running ? <RunningTimerBanner session={running} timeZone={tz} timeTrackingEnabled={ctx.settings.timeTrackingEnabled} /> : null}

      {total === 0 ? (
        <EmptyState
          bordered
          size="lg"
          icon={Sparkles}
          title="All clear — nothing on your plate"
          description={
            perspective === "editor"
              ? "No jobs are assigned to you right now. New work appears here the moment it is assigned, with its deadline and links ready to go."
              : "None of your jobs need anything right now. Create a job, or check All Work to see what the rest of the team is on."
          }
          action={
            <>
              {canCreate ? (
                <Button href="/jobs/new" leadingIcon={<Plus />}>
                  Create a job
                </Button>
              ) : null}
              <Button href="/workspace/all" variant="outline" leadingIcon={<LayoutList />}>
                Browse All Work
              </Button>
            </>
          }
        />
      ) : (
        <>
          <SummaryStrip sections={sections} counts={counts} />
          <div className="flex flex-col gap-6">
            {sections.map((section) => (
              <QueueSection
                key={section.key}
                sectionKey={section.key}
                title={section.title}
                description={section.description}
                empty={section.empty}
                tone={section.tone}
                icon={section.icon}
                count={counts[section.key]}
                defaultCollapsed={section.defaultCollapsed}
              >
                {queue[section.key].map((job) => (
                  <WorkCard
                    key={job.id}
                    job={job}
                    viewer={viewerRef}
                    perspective={perspective}
                    timeZone={tz}
                    timeTrackingEnabled={ctx.settings.timeTrackingEnabled}
                    runningSession={running && running.job.id === job.id ? { id: running.id, startedAt: running.startedAt } : null}
                    note={notes[job.id] ?? null}
                    tone={section.tone}
                  />
                ))}
              </QueueSection>
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}
