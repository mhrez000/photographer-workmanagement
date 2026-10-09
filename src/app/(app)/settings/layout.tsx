import * as React from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { pageContext } from "@/server/page";

/**
 * Settings chrome: sticky left sub-nav on desktop, a section select on
 * mobile. Studio sections are hidden for photographers/editors; every page
 * still re-checks its own permission server-side.
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const { ctx } = await pageContext();
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <SettingsNav role={ctx.role} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
