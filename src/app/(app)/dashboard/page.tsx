import type { Metadata } from "next";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Dashboard" };

/** Placeholder — replaced by the dashboard agent. */
export default function DashboardPage() {
  return (
    <PageContainer>
      <PageHeader title="Dashboard" description="Dashboard — coming soon." />
    </PageContainer>
  );
}
