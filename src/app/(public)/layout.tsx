import * as React from "react";
import { redirect } from "next/navigation";
import { PublicFooter, PublicHeader } from "@/components/marketing";
import { getOptionalContext } from "@/server/auth/session";
import { homePathFor } from "@/server/page";

/**
 * Public front door (the landing page). No app shell: brand, "Sign in", "Create your studio".
 *
 * A signed-in person never sees it: they go to their landing page (docs/SIMPLIFICATION-PLAN.md §3:
 * clients → /portal, editors → /my-jobs, photographers → /home). The redirect lives in the LAYOUT so it
 * runs above the segment's loading boundary and the response is a real 307, not a streamed one.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getOptionalContext();
  if (ctx) redirect(homePathFor(ctx));

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-canvas">
      <PublicHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
