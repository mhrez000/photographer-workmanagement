import * as React from "react";
import { AlarmClock, CalendarClock, Gauge, Layers } from "lucide-react";
import { StatTile } from "@/components/common/stat-tile";
import { pluralise } from "@/lib/utils";
import type { DirectoryPerson, DirectoryRole } from "./types";

/** Team totals above a directory (only rendered when the viewer may see aggregates). */
export function DirectorySummary({ role, people }: { role: DirectoryRole; people: DirectoryPerson[] }) {
  const active = people.filter((p) => p.user.isActive);
  const sum = (fn: (p: DirectoryPerson) => number | null | undefined) => active.reduce((s, p) => s + (fn(p) ?? 0), 0);
  const overloaded = people.filter((p) => p.workload?.band === "overloaded");
  const near = people.filter((p) => p.workload?.band === "near_capacity");
  const overdue = sum((p) => p.stats?.overdue);
  const dueToday = sum((p) => p.stats?.dueToday);
  const withOverdue = active.filter((p) => (p.stats?.overdue ?? 0) > 0).length;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label={role === "editor" ? "Active editors" : "Active photographers"} value={active.length} sub={`${pluralise(sum((p) => p.stats?.active), "open job")}`} icon={Layers} />
      <StatTile
        label="Due today"
        value={dueToday}
        tone={dueToday > 0 ? "attention" : "default"}
        sub={dueToday > 0 ? "Across the team" : "Nothing due today"}
        icon={CalendarClock}
        href={`/workspace/all?quick=due_today`}
      />
      <StatTile
        label="Overdue"
        value={overdue}
        tone={overdue > 0 ? "danger" : "success"}
        sub={overdue > 0 ? `${pluralise(withOverdue, "person", "people")} behind` : "Everyone is on schedule"}
        icon={AlarmClock}
        href="/workspace/all?quick=overdue"
      />
      {role === "editor" ? (
        <StatTile
          label="Overloaded"
          value={overloaded.length}
          tone={overloaded.length > 0 ? "danger" : "success"}
          sub={
            overloaded.length > 0
              ? overloaded
                  .slice(0, 2)
                  .map((p) => p.user.name.split(" ")[0])
                  .join(", ") + (overloaded.length > 2 ? ` +${overloaded.length - 2}` : "")
              : near.length > 0
                ? `${near.length} near capacity`
                : "Capacity looks healthy"
          }
          icon={Gauge}
          href="/team/workloads"
        />
      ) : (
        <StatTile
          label="Completed this month"
          value={sum((p) => p.output?.completed ?? p.stats?.completedThisMonth)}
          sub={`${pluralise(sum((p) => p.output?.submitted), "job")} submitted`}
          tone="accent"
          icon={Gauge}
        />
      )}
    </div>
  );
}
