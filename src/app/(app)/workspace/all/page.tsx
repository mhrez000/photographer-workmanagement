import { redirect } from "next/navigation";

/** All Work is gone (docs/SIMPLIFICATION-PLAN.md §3): there is one Jobs list. next.config.ts 307s first; this is the fallback. */
export default function AllWorkRedirect() {
  redirect("/jobs");
}
