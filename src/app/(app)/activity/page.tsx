import { redirect } from "next/navigation";

/**
 * The Activity page moved to Settings → History (docs/SIMPLIFICATION-PLAN.md §3). next.config.ts
 * already redirects /activity; this keeps the old address working even without that rule. The CSV
 * export route (./export) stays and is linked from History.
 */
export default function ActivityPage() {
  redirect("/settings/history");
}
