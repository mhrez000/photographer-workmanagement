import { Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OnboardingState } from "@/server/queries/onboarding";
import { firstName } from "./greeting";
import { GetSetUpCard } from "./get-set-up";

export interface FirstRunHomeProps {
  viewerName: string;
  state: OnboardingState;
  canCreate: boolean;
  canInvite: boolean;
}

/**
 * Home for a brand-new studio with no jobs yet (front door): a welcome instead of the "N to check"
 * line, the Get set up checklist front and centre, and the two obvious buttons.
 */
export function FirstRunHome({ viewerName, state, canCreate, canInvite }: FirstRunHomeProps) {
  return (
    <div className="flex flex-col gap-6" data-first-run="">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-8 tracking-tight text-ink">Welcome{viewerName ? `, ${firstName(viewerName)}` : ""}.</h1>
          <p className="mt-1 max-w-prose text-base text-ink-secondary">Shoot, give it to an editor, check it, done. Proofline keeps one list of jobs and always shows the next step. Let’s set up your studio.</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          {canCreate ? (
            <Button href="/jobs/new" size="lg" leadingIcon={<Plus aria-hidden="true" />}>
              Create your first job
            </Button>
          ) : null}
          {canInvite ? (
            <Button href="/settings/people?invite=editor" size="lg" variant="outline" leadingIcon={<UserPlus aria-hidden="true" />}>
              Invite an editor
            </Button>
          ) : null}
        </div>
      </header>
      <GetSetUpCard state={state} prominent className="max-w-3xl" />
    </div>
  );
}
