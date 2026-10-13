import { SearchX } from "lucide-react";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getOptionalContext } from "@/server/auth/session";
import { EDITOR_HOME_PATH } from "@/server/page";

/** Unknown job id / number, another studio's job, or one this person cannot see — all look the same. */
export default async function JobNotFound() {
  // Editors have one list, My jobs (plan §3); everyone else browses Jobs.
  const ctx = await getOptionalContext().catch(() => null);
  const editor = ctx?.role === "editor";
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
              <Button href={editor ? EDITOR_HOME_PATH : "/jobs"}>{editor ? "Back to My jobs" : "Browse jobs"}</Button>
              {editor ? null : (
                <Button href="/" variant="outline">
                  Home
                </Button>
              )}
            </>
          }
        />
      </Card>
    </PageContainer>
  );
}
