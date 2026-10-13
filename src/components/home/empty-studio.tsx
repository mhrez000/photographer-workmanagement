import { Camera, Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export interface EmptyStudioProps {
  canCreate: boolean;
  canInvite: boolean;
}

/** "No jobs yet. [+ Create your first job] [Invite an editor]" (docs/SIMPLIFICATION-PLAN.md §6). */
export function EmptyStudio({ canCreate, canInvite }: EmptyStudioProps) {
  return (
    <Card>
      <EmptyState
        size="lg"
        icon={Camera}
        title="No jobs yet"
        description="Shoot, give it to an editor, check it, done. Create your first job to get going."
        action={
          <>
            {canCreate ? (
              <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />}>
                Create your first job
              </Button>
            ) : null}
            {canInvite ? (
              <Button href="/settings/people?invite=1" variant="outline" leadingIcon={<UserPlus aria-hidden="true" />}>
                Invite an editor
              </Button>
            ) : null}
          </>
        }
      />
    </Card>
  );
}
