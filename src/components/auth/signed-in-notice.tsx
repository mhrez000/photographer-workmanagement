import Link from "next/link";
import { LogOut, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { signOutToInviteAction } from "@/server/actions/auth";

export interface SignedInNoticeProps {
  /** The person this browser is signed in as. */
  viewerName: string;
  viewerEmail: string;
  /** Where that person's own home is ("Stay signed in"). */
  homeHref: string;
  /** The invite being looked at: whose it is and where it goes. */
  inviteEmail: string;
  studioName: string;
  /** The invite page to come back to after signing out. */
  returnTo: string;
}

/**
 * /invite/[token] opened while SOMEONE ELSE is signed in on this browser (a forwarded link, an owner testing
 * the link they just made). No accept form: joining would silently replace the current session with the other
 * person's account. One explicit choice instead — sign out and come back to the invite, or stay.
 */
export function SignedInNotice({ viewerName, viewerEmail, homeHref, inviteEmail, studioName, returnTo }: SignedInNoticeProps) {
  return (
    <div className="flex flex-col gap-5" data-signed-in-notice="">
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
            <UserRound aria-hidden="true" className="size-5" />
          </div>
          <div role="status">
            <h2 className="text-md font-semibold text-ink">
              You’re signed in as <span className="whitespace-nowrap">{viewerName}</span>
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              This invite is for <span className="font-medium text-ink">{inviteEmail}</span> to join <span className="font-medium text-ink">{studioName}</span>. Sign out of{" "}
              <span className="font-medium text-ink">{viewerEmail}</span> to accept it; nothing happens until you do.
            </p>
          </div>
          <form action={signOutToInviteAction} className="w-full">
            <input type="hidden" name="next" value={returnTo} />
            <Button type="submit" size="lg" className="w-full" leadingIcon={<LogOut aria-hidden="true" />}>
              Sign out to accept this invite
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-center text-sm text-ink-muted">
        Not for you?{" "}
        <Link href={homeHref} className="font-medium text-accent-ink underline-offset-4 hover:underline">
          Stay signed in
        </Link>
      </p>
    </div>
  );
}
