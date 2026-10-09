import { SearchX } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/** Unknown job id / number, another studio's job, or one this person cannot see — all look the same. */
export default function JobNotFound() {
  return (
    <PageContainer width="narrow">
      <Card>
        <EmptyState
          icon={SearchX}
          size="lg"
          title="We can't find that job"
          description="The job number or link may be mistyped, or the job isn't shared with you. Search by job number (like PJ-0042), client or address to find it."
          action={
            <>
              <Button href="/jobs">Browse jobs</Button>
              <Button href="/workspace/my" variant="outline">
                My work
              </Button>
            </>
          }
        />
      </Card>
    </PageContainer>
  );
}
