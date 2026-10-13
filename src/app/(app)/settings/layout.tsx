import * as React from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { allowed, pageContext } from "@/server/page";

/**
 * The one Settings entry (docs/SIMPLIFICATION-PLAN.md §3): a tab strip — Studio ·
 * People · Types of shoot · My account · History — for admins; everyone else only has
 * My account. Every tab page still re-checks its own permission server-side (the
 * gates sit in each segment's layout so a denied request gets a real 403).
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const { ctx } = await pageContext();
  return (
    <div className="flex flex-1 flex-col">
      <SettingsTabs isAdmin={allowed(ctx, "settings.view")} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
