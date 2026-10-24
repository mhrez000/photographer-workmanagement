import Link from "next/link";
import { ArrowRight, LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { signOutAction } from "@/server/actions/auth";
import { LOG_OUT_EVERYWHERE_NOTE, homeLabelFor } from "./auth-helpers";
import { PendingSubmitButton } from "./pending-submit-button";

export interface SignedInNoticeProps {
  /** The person this browser is signed in as. */
  viewerName: string;
  viewerEmail: string;
  /** Their role: the "back" button's words follow it ("Go to your studio" / "Go to my jobs" / "See your work"). */
  viewerRole: "photographer" | "editor" | "client";
  /** Where that person's own home is (the "back" button / "Stay signed in"). */
  homeHref: string;
  /**
   * The invite being looked at (/invite/[token]): whose it is and which studio. Leave both out on /login and /signup —
   * the notice then just says who is signed in and offers to go back or log out.
   */
  inviteEmail?: string;
  studioName?: string;
  /** The page to come back to after logging out (allowlisted server-side: /login, /signup, /invite/<token>). */
  returnTo: string;
}

/**
 * A signed-in person on a front-door page. Two cases:
 *
 * - /login, /signup (docs/ACCOUNTS.md §1): who is signed in, then [Go to your studio / my jobs / See your work]
 *   [Log out] instead of the form — signing in or creating a studio again would silently replace the session.
 * - /invite/[token] opened while SOMEONE ELSE is signed in on this browser (a forwarded link, an owner testing the link
 *   they just made): no accept form, one explicit choice instead — log out and come back to the invite, or stay.
 *
 * "Log out" ends the account's sign-in on every device (users.session_version), so the notice says so (UX-03).
 */
export function SignedInNotice({ viewerName, viewerEmail, viewerRole, homeHref, inviteEmail, studioName, returnTo }: SignedInNoticeProps) {
  const invite = inviteEmail && studioName ? { email: inviteEmail, studio: studioName } : null;
  return (
    <div className="flex flex-col gap-5" data-signed-in-notice="">
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
            <UserRound aria-hidden="true" className="size-5" />
          </div>
          <div role="status" className="min-w-0">
            <h2 className="text-md font-semibold break-words text-ink">{viewerName}</h2>
            {invite ? (
              <p className="mt-1 text-sm text-ink-muted">
                This invite is for <span className="font-medium break-all text-ink">{invite.email}</span> to join{" "}
                <span className="font-medium text-ink">{invite.studio}</span>. Log out of{" "}
                <span className="font-medium break-all text-ink">{viewerEmail}</span> to accept it; nothing happens until you do.{" "}
                {LOG_OUT_EVERYWHERE_NOTE}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                <span className="font-medium break-all text-ink">{viewerEmail}</span>, on this browser. {LOG_OUT_EVERYWHERE_NOTE}
              </p>
            )}
          </div>
          {invite ? (
            <form action={signOutAction} className="w-full">
              <input type="hidden" name="next" value={returnTo} />
              <PendingSubmitButton size="lg" className="w-full" leadingIcon={<LogOut aria-hidden="true" />} pendingLabel="Logging out…">
                Log out to accept this invite
              </PendingSubmitButton>
            </form>
          ) : (
            <div className="flex w-full flex-col gap-2">
              <Button href={homeHref} size="lg" className="w-full" trailingIcon={<ArrowRight aria-hidden="true" />} data-go-to-studio="">
                {homeLabelFor(viewerRole)}
              </Button>
              <form action={signOutAction} className="w-full">
                <input type="hidden" name="next" value={returnTo} />
                <PendingSubmitButton size="lg" variant="outline" className="w-full" leadingIcon={<LogOut aria-hidden="true" />} pendingLabel="Logging out…">
                  Log out
                </PendingSubmitButton>
              </form>
            </div>
          )}
        </CardContent>
      </Card>
      {invite ? (
        <p className="text-center text-sm text-ink-muted">
          Not for you?{" "}
          <Link href={homeHref} className="font-medium text-accent-ink underline-offset-4 hover:underline">
            Stay signed in
          </Link>
        </p>
      ) : null}
    </div>
  );
}
