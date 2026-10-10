import * as React from "react";
import type { Metadata } from "next";
import { PortalHeader } from "@/components/portal/portal-header";
import { Toaster } from "@/components/ui/toast";
import { getViewer } from "@/server/auth/session";
import { portalPageContext } from "@/server/page";
import { portalUnreadCount } from "@/server/queries/portal";

export const metadata: Metadata = {
  title: { default: "Your work", template: "%s · Proofline" },
};

/**
 * Client portal chrome (docs/ROLES.md §7.7) — NOT under (app): no sidebar, no
 * search, no ⌘K. Staff are redirected to /dashboard and signed-out visitors to
 * /login by `portalPageContext()`; every /api/portal/** route re-checks with
 * `requirePortalContext()`.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const { ctx, db } = await portalPageContext();
  const viewer = await getViewer();
  const unread = await portalUnreadCount(db, ctx);
  const studioName = viewer?.organisationName ?? "Your studio";
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink [--tabbar-height:0px]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-popover) focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-md">
        Skip to content
      </a>
      <PortalHeader
        studioName={studioName}
        clientName={viewer?.clientName ?? ""}
        user={{ name: viewer?.name ?? "", email: viewer?.email ?? "", avatarColour: viewer?.avatarColour ?? "#64748b" }}
        unreadCount={unread}
      />
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-16 sm:px-6 sm:pt-10">
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-ink-muted sm:px-6">
          <span>Shared with you by {studioName}</span>
          <span>Powered by Proofline</span>
        </div>
      </footer>
      <Toaster />
    </div>
  );
}
