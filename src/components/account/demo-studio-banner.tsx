import { Eye, Sparkles } from "lucide-react";
import { PendingSubmitButton } from "@/components/auth/pending-submit-button";
import type { AccountSurface } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { signOutAction } from "@/server/actions/auth";

export interface DemoStudioBannerProps {
  /** Staff shell or client portal (the button signs the visitor out and lands on /signup either way). */
  surface: AccountSurface;
}

/**
 * The quiet strip above every page of the demo studio (docs/ACCOUNTS.md §7; `AccountBanners` decides when):
 * "You're looking at the demo studio. Anyone can see changes here. [Create your own studio]". The button is a
 * server-action form: it signs this browser out (in the demo studio that never signs out the other visitors sharing
 * the persona) and lands on /signup (allowlisted return path).
 */
export function DemoStudioBanner({ surface }: DemoStudioBannerProps) {
  return (
    <div
      role="region"
      aria-label="Demo studio"
      className="border-b border-accent/20 bg-accent-soft/40"
      data-demo-studio-banner=""
      data-surface={surface}
    >
      {/* Line the text up with the page below it: the portal's column is narrower than the staff shell's. */}
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-2.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6",
          surface === "portal" ? "max-w-5xl" : "max-w-[1440px] lg:px-8",
        )}
      >
        <p className="flex min-w-0 items-start gap-2 text-sm text-ink-secondary">
          <Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-ink" />
          <span className="min-w-0">
            <span className="font-medium text-ink">You’re looking at the demo studio.</span> Anyone can see changes here.
          </span>
        </p>
        <form action={signOutAction} className="shrink-0 pl-6 sm:pl-0">
          <input type="hidden" name="next" value="/signup" />
          <PendingSubmitButton size="sm" leadingIcon={<Sparkles aria-hidden="true" />} pendingLabel="Opening sign-up…" data-create-own-studio="">
            Create your own studio
          </PendingSubmitButton>
        </form>
      </div>
    </div>
  );
}
