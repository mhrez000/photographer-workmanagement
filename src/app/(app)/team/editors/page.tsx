import type { Metadata } from "next";
import { Gauge } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { DirectorySummary } from "@/components/team/directory-summary";
import { DirectoryView } from "@/components/team/directory-view";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { guard, load, pageContext } from "@/server/page";
import { loadDirectory } from "../_lib/directory";

export const metadata: Metadata = { title: "Editors" };

export default async function EditorsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "team.view_members");
  const { people, showStats } = await load(() => loadDirectory(db, ctx, "editor"));

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Team"
        title="Editors"
        description={
          showStats
            ? "Who is editing what, who is behind and who has room for more. Open a person for their full workload."
            : "Everyone editing for the studio."
        }
        actions={
          showStats ? (
            <Button variant="outline" href="/team/workloads" leadingIcon={<Gauge aria-hidden="true" />}>
              Workloads
            </Button>
          ) : null
        }
      />
      {showStats && people.length > 0 ? <DirectorySummary role="editor" people={people} /> : null}
      <DirectoryView role="editor" people={people} showStats={showStats} />
    </PageContainer>
  );
}
