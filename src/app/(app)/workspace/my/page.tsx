import { redirect } from "next/navigation";
import { homePathFor, pageContext } from "@/server/page";

/** My Work is gone (docs/SIMPLIFICATION-PLAN.md §3): editors land on My jobs, photographers on Jobs. The proxy 307s first; this is the fallback. */
export default async function MyWorkRedirect() {
  const { ctx } = await pageContext();
  redirect(ctx.role === "editor" ? homePathFor(ctx) : "/jobs");
}
