import type { Metadata } from "next";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { invalidInviteBody } from "@/components/auth/auth-helpers";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { InvalidLinkCard } from "@/components/auth/invalid-link-card";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import { getDb } from "@/db";
import type { Persona } from "@/lib/constants";
import { cleanToken } from "@/lib/validation/auth";
import { getViewer } from "@/server/auth/session";
import { homePathFor } from "@/server/page";
import { lookupInvite } from "@/server/services/invites";

export const metadata: Metadata = { title: "You’re invited" };

/** One line for someone who has never heard of Proofline, by what they were invited as. */
function whatProoflineIs(persona: Persona, studio: string): string {
  switch (persona) {
    case "editor":
      return `Proofline is where ${studio} hands you jobs to edit and checks them.`;
    case "client":
      return `Proofline is where ${studio} shows you how your photos are coming along.`;
    default:
      return `Proofline is where ${studio} keeps its jobs: shoot, give it to an editor, check it, done.`;
  }
}

/**
 * /invite/:token — accept an invite (docs/SIMPLIFICATION-PLAN.md §2: three roles, plain words).
 * The token is cleaned first (`cleanToken`: a trailing %20 from a mail client is forgiven, like on the reset
 * page), then looked up on the server through the same function as `GET /api/auth/invite/:token`
 * (`lookupInvite`): a live link shows who invited you, to which studio and as what; anything else (unknown /
 * expired / used / revoked / truncated — indistinguishable on purpose) shows the dead-link card.
 *
 * Signed-in guard: when THIS browser already holds a session, the accept form is not shown — joining would
 * replace that session with the invitee's account without a word. The person sees who they are signed in as
 * and chooses: sign out and come back, or stay.
 *
 * Joining goes through `POST /api/auth/invite/:token/accept` from the form.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = cleanToken(raw);
  const invite = await lookupInvite(getDb(), { token });

  if (!invite.valid) {
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title="This invite link is no longer valid" />
        <InvalidLinkCard title="We couldn’t open this invite" body={invalidInviteBody(null)} actionHref="/login?from=invite" actionLabel="Go to sign in" />
      </div>
    );
  }

  const viewer = await getViewer();
  if (viewer) {
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title={`Join ${invite.studioName}`} lede="This invite is waiting, but this browser is already signed in." />
        <SignedInNotice
          viewerName={viewer.name}
          viewerEmail={viewer.email}
          homeHref={homePathFor({ role: viewer.role })}
          inviteEmail={invite.email}
          studioName={invite.studioName}
          returnTo={`/invite/${encodeURIComponent(token)}`}
        />
      </div>
    );
  }

  const inviter = invite.inviterName?.trim() || invite.studioName;
  return (
    <AcceptInviteForm
      token={token}
      studioName={invite.studioName}
      email={invite.email}
      initialName={invite.name}
      header={
        <AuthPageHeader
          title={`Join ${invite.studioName}`}
          lede={
            <>
              <span className="font-medium text-ink">{inviter}</span> invited you to <span className="font-medium text-ink">{invite.studioName}</span> as{" "}
              <span className="font-medium text-ink">{invite.personaLabel}</span>. {whatProoflineIs(invite.persona, invite.studioName)} Choose a password to get started.
            </>
          }
        />
      }
    />
  );
}
