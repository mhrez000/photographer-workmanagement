import * as React from "react";
import { homeLabelFor } from "@/components/auth/auth-helpers";
import { PublicFooter, PublicHeader } from "@/components/marketing";
import { getViewer } from "@/server/auth/session";
import { homePathFor } from "@/server/page";

/**
 * Public front door (the landing page). No app shell: brand, "Sign in", "Create your studio".
 *
 * Accounts (docs/ACCOUNTS.md §1): a signed-in person sees the landing page too — no redirect — and the header swaps
 * "Sign in" / "Create your studio" for one "Go to your studio" button (their landing page: clients /portal, editors
 * /my-jobs, photographers /home), so the way back is always obvious.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  const account = viewer ? { name: viewer.name, homeHref: homePathFor({ role: viewer.role }), homeLabel: homeLabelFor(viewer.role) } : null;

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-canvas">
      <PublicHeader account={account} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <PublicFooter home={account ? { href: account.homeHref, label: account.homeLabel } : null} />
    </div>
  );
}
