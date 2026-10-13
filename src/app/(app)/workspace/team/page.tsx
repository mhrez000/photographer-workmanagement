import { redirect } from "next/navigation";

/** Team Work is gone (docs/SIMPLIFICATION-PLAN.md §3): it was the same list as Jobs. next.config.ts 307s first; this is the fallback. */
export default function TeamWorkRedirect() {
  redirect("/jobs");
}
