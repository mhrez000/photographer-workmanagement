import { redirect } from "next/navigation";
import { getOptionalContext } from "@/server/auth/session";
import { homePathFor } from "@/server/page";

/** Landing by role (docs/SIMPLIFICATION-PLAN.md §3): clients → /portal, editors → /my-jobs, photographers → /home. */
export default async function Home() {
  const ctx = await getOptionalContext();
  redirect(ctx ? homePathFor(ctx) : "/login");
}
