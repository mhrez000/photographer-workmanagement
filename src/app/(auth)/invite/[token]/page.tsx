import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { homeLabelFor, invalidInviteBody } from "@/components/auth/auth-helpers";
import { Button } from "@/components/ui/button";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { ContinueWithGoogle, GoogleResultAlert } from "@/components/auth/continue-with-google";
import { InvalidLinkCard } from "@/components/auth/invalid-link-card";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import { getDb } from "@/db";
import type { Persona } from "@/lib/constants";
import { cleanToken } from "@/lib/validation/auth";
import { googleAuthConfig } from "@/server/auth/google-config";
import { getViewer } from "@/server/auth/session";
import { homePathFor } from "@/server/page";
import { joinedWithInvite, lookupInvite } from "@/server/services/invites";

/** The tab says what the page says (UX-14): an invitation, or a link that no longer works. */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const invite = await lookupInvite(getDb(), { token: cleanToken(token) });
  return { title: invite.valid ? "You’re invited" : "Invite link no longer valid", referrer: "no-referrer" };
}

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
 * Joining goes through `POST /api/auth/invite/:token/accept` from the form — or, when Google sign-in is configured,
 * "Continue with Google" under it (GET /api/auth/google/start?intent=invite&invite=<token>; accounts, AREA google).
 * A round trip's `?google=<result>` (cancelled, refused, linked elsewhere, …) is shown next to that button.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token: raw } = await params;
  const query = await searchParams;
  const google = Array.isArray(query.google) ? query.google[0] : query.google;
  const token = cleanToken(raw);
  const invite = await lookupInvite(getDb(), { token });

  if (!invite.valid) {
    const viewer = await getViewer();
    if (viewer) {
      const home = homePathFor({ role: viewer.role });
      // UX-06: their OWN link, already used to join → say so, and take them back in.
      const joined = await joinedWithInvite(getDb(), { token }, viewer.id);
      if (joined) {
        return (
          <div className="flex flex-col gap-8" data-invite-state="already_joined">
            <AuthPageHeader title={`You’ve already joined ${joined.studioName}`} lede="This invite link has done its job: you’re in." />
            <Button href={home} size="lg" className="w-full" trailingIcon={<ArrowRight aria-hidden="true" />} data-go-to-studio="">
              {homeLabelFor(viewer.role)}
            </Button>
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-8" data-invite-state="dead">
          <AuthPageHeader title="This invite link is no longer valid" />
          <InvalidLinkCard body={invalidInviteBody(null, { signedIn: true })} actionHref={home} actionLabel={homeLabelFor(viewer.role)} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-8" data-invite-state="dead">
        <AuthPageHeader title="This invite link is no longer valid" />
        <InvalidLinkCard body={invalidInviteBody(null)} actionHref="/login?from=invite" actionLabel="Sign in" />
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
          viewerRole={viewer.role}
          homeHref={homePathFor({ role: viewer.role })}
          inviteEmail={invite.email}
          studioName={invite.studioName}
          returnTo={`/invite/${encodeURIComponent(token)}`}
        />
      </div>
    );
  }

  const inviter = invite.inviterName?.trim() || invite.studioName;
  const getStarted = googleAuthConfig() ? "Choose a password, or continue with Google, to get started." : "Choose a password to get started.";
  return (
    <div className="flex flex-col gap-5">
      {/* A Google round trip's result first, where someone back from Google looks (UX-16). */}
      <GoogleResultAlert surface="invite" result={google} />
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
                <span className="font-medium text-ink">{invite.personaLabel}</span>. {whatProoflineIs(invite.persona, invite.studioName)} {getStarted}
              </>
            }
          />
        }
        // Accounts: AREA google's slot, under the password card (renders nothing unless Google sign-in is configured).
        alternative={<ContinueWithGoogle intent="invite" invite={token} />}
      />
    </div>
  );
}
