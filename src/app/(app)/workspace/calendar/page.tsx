import type { Metadata } from "next";
import { CalendarView } from "@/components/calendar/calendar-view";
import {
  EVENT_KINDS,
  normaliseCivil,
  normaliseColourMode,
  normaliseView,
  normaliseWeekStart,
  viewRange,
} from "@/components/calendar/calendar-utils";
import { FilterBar } from "@/components/filters/filter-bar";
import { PageContainer, ScopeNotice } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { todayCivil } from "@/lib/dates";
import type { CalendarEventKind } from "@/lib/types";
import { load, pageContext, param, params } from "@/server/page";
import { pageScope } from "@/server/page-scope";
import { getCalendarEvents } from "@/server/queries/calendar";
import { loadOrgSettingsRow } from "@/server/queries/scope";

export const metadata: Metadata = { title: "Calendar" };

/**
 * /workspace/calendar — shoot dates and deadlines (spec §10, ARCHITECTURE §10).
 * URL state: ?view=month|week|day|agenda (none = month on desktop, agenda on
 * phones) &date=YYYY-MM-DD &colour=status|priority|overdue|editor &kinds=…
 * plus the job filters. All roles; events are row-scoped by the query.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/workspace/calendar">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;
  const today = todayCivil(timeZone);

  const view = normaliseView(param(sp, "view"));
  const date = normaliseCivil(param(sp, "date"), today);
  const colourMode = normaliseColourMode(param(sp, "colour"));
  const kindParam = params(sp, "kinds").filter((k): k is CalendarEventKind => (EVENT_KINDS as string[]).includes(k));
  const kinds = kindParam.length > 0 ? kindParam : EVENT_KINDS;
  const weekStartsOn = normaliseWeekStart((await load(() => loadOrgSettingsRow(db, ctx)))?.weekStartsOn);
  const range = viewRange(view, date, weekStartsOn);

  // Personal vs business view (docs/ROLES.md §8): `?scope=` wins over the cookie.
  const { scope, scopeCookie } = await pageScope(ctx, param(sp, "scope"));
  const events = await load(() =>
    getCalendarEvents(
      db,
      ctx,
      {
      scope: param(sp, "scope"),
      from: range.from,
      to: range.to,
      kinds,
      q: param(sp, "q"),
      editorId: params(sp, "editorId"),
      photographerId: params(sp, "photographerId"),
      clientId: params(sp, "clientId"),
      priority: params(sp, "priority"),
      },
      { scopeCookie },
    ),
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Calendar"
        description="Shoots, editing, review, delivery and revision deadlines in one place. Overdue items are flagged in red."
        meta={<ScopeNotice scope={scope} />}
      >
        <FilterBar quickFilters={[]} facets={["editor", "photographer", "client", "priority"]} timeZone={ctx.settings.timezone} searchPlaceholder="Filter by job, client…" />
      </PageHeader>
      <CalendarView
        events={events}
        view={view}
        date={date}
        today={today}
        range={range}
        weekStartsOn={weekStartsOn}
        timeZone={timeZone}
        colourMode={colourMode}
        kinds={kinds}
      />
    </PageContainer>
  );
}
