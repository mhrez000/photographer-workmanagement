import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { DirectorySummary } from "@/components/team/directory-summary";
import { DirectoryView } from "@/components/team/directory-view";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { allowed, guard, load, pageContext } from "@/server/page";
import { loadDirectory } from "../_lib/directory";

export const metadata: Metadata = { title: "Photographers" };

export default async function PhotographersPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "team.view_members");
  const { people, showStats } = load(() => loadDirectory(db, ctx, "photographer"));

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Team"
        title="Photographers"
        description={
          showStats
            ? "Shoots in flight, what's waiting on review and what each photographer has delivered this month."
            : "Everyone shooting for the studio."
        }
        actions={
          allowed(ctx, "performance.view") ? (
            <Button variant="outline" href="/team/performance#photographers" leadingIcon={<BarChart3 aria-hidden="true" />}>
              Performance
            </Button>
          ) : null
        }
      />
      {showStats && people.length > 0 ? <DirectorySummary role="photographer" people={people} /> : null}
      <DirectoryView role="photographer" people={people} showStats={showStats} />
    </PageContainer>
  );
}
