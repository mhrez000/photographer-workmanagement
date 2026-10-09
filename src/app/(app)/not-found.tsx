import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Not found" };

/**
 * 404 inside the app shell: a record that does not exist, belongs to another
 * studio, or is not visible to this person all look the same (no existence leak).
 */
export default function AppNotFound() {
  return (
    <PageContainer width="narrow">
      <Card>
        <EmptyState
          icon={Compass}
          size="lg"
          title="We can't find that"
          description="The link may be out of date, or this record isn't shared with you. Try searching for it instead."
          action={
            <>
              <Button href="/dashboard">Go to dashboard</Button>
              <Button href="/search" variant="outline">
                Search
              </Button>
            </>
          }
        />
      </Card>
    </PageContainer>
  );
}
