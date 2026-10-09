import type { Metadata } from "next";
import { BellRing, Mail } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { NotificationPrefsForm } from "@/components/settings/notification-prefs-form";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { getNotificationPrefs } from "@/server/queries/settings";
import { guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "notification.prefs");
  const prefs = load(() => getNotificationPrefs(db, ctx));

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings · Personal"
        title="Notifications"
        description="Choose what shows up in your notification centre. Changes apply straight away and only to you."
        actions={
          <Button variant="outline" size="sm" href="/notifications" leadingIcon={<BellRing aria-hidden="true" />}>
            Open notifications
          </Button>
        }
      />
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-ink-secondary">
        <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <p>
          Notifications are in-app for now. <span className="text-ink-muted">Email and push delivery are coming later — these same preferences will apply.</span>
        </p>
      </div>
      <NotificationPrefsForm userId={ctx.userId ?? ""} prefs={prefs} />
    </PageContainer>
  );
}
