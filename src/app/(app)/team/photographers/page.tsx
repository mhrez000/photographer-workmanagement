import { redirect } from "next/navigation";

/**
 * Team → Photographers merged into Settings → People (docs/SIMPLIFICATION-PLAN.md §3, §8). Server-side
 * twin of the `next.config.ts` redirect so the old link keeps working.
 */
export default function LegacyTeamPhotographersPage(): never {
  redirect("/settings/people");
}
