import { redirect } from "next/navigation";
import { homePathFor } from "@/server/page";
import { getOptionalContext } from "@/server/auth/session";

/**
 * /dashboard is gone (docs/SIMPLIFICATION-PLAN.md §3 "Old links keep working"): next.config.ts
 * already 307s it to /home; this page is the fallback for a request that reaches the router.
 */
export default async function DashboardRedirect() {
  const ctx = await getOptionalContext();
  redirect(ctx ? homePathFor(ctx) : "/login");
}
