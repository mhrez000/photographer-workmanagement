import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { PageHeader } from "@/components/ui/page-header";
import { pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Appearance" };

export default async function AppearanceSettingsPage() {
  await pageContext();
  return (
    <PageContainer width="narrow">
      <PageHeader eyebrow="Settings · Personal" title="Appearance" description="Theme and density for this device. Changes apply instantly." />
      <AppearanceSettings />
    </PageContainer>
  );
}
