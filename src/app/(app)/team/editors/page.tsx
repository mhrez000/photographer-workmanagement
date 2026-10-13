import { redirect } from "next/navigation";

/**
 * Team → Editors merged into the one Editors page (docs/SIMPLIFICATION-PLAN.md §3 "Old links keep
 * working"). `next.config.ts` already redirects this address; this page is the server-side twin so the
 * old link keeps working even when that table changes.
 */
export default function LegacyTeamEditorsPage(): never {
  redirect("/editors");
}
