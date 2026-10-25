"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck, Clock, LogIn, MailCheck, Send } from "lucide-react";
import { requestNewConfirmationLink, type ResendConfirmationOutcome } from "@/components/account/resend-email-confirmation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DEAD_LINK_CHECK, minutesLeft, retryAfterOf } from "./auth-helpers";
import { DevOnlyLink } from "./dev-only-link";
import { FormAlert } from "./form-alert";
import { InvalidLinkCard } from "./invalid-link-card";

/** `POST /api/auth/verify-email` success body. */
interface VerifyEmailResult {
  ok: true;
  email: string;
  signedIn: boolean;
  redirectTo: string;
}

/** Why a link did not work (`details.reason` of the 400; src/server/services/emailVerification.ts). */
type DeadLinkReason = "invalid" | "expired" | "used" | "already_confirmed";
const DEAD_LINK_REASONS: readonly DeadLinkReason[] = ["invalid", "expired", "used", "already_confirmed"];

function deadLinkReasonOf(err: ApiError): DeadLinkReason {
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  return DEAD_LINK_REASONS.find((r) => r === reason) ?? "invalid";
}

/** The person who has this browser signed in (null when nobody is). */
export interface VerifyEmailViewer {
  email: string;
  /** Their own address is already confirmed (no "Send a new link" for them). */
  confirmed: boolean;
  /** Where "Continue" goes for them (Home, My jobs or the portal). */
  homeHref: string;
  /** Their account page's Email card (`…/account#email`). */
  accountHref: string;
}

export interface VerifyEmailFormProps {
  /** From `?token=`; null when missing or malformed (the page already checked the shape). */
  token: string | null;
  viewer: VerifyEmailViewer | null;
}

type Phase =
  | { kind: "ready" }
  | { kind: "confirmed"; email: string; redirectTo: string; signedIn: boolean }
  | { kind: "dead"; reason: DeadLinkReason };

/** Body of a link that did not open (invalid / mangled / for an old address). */
export const VERIFY_DEAD_LINK_BODY = `${DEAD_LINK_CHECK} from the email. If you already confirmed your email, you’re all set.`;

/**
 * /verify-email (AREA verify): "Confirm my email" on a BUTTON press (POST /api/auth/verify-email) — never on opening
 * the page, because mail scanners open links. Works signed in or out and never signs anyone in. States:
 * ready → confirmed ("Email confirmed" + Continue); already used (the address is confirmed: all set); replaced by a
 * newer link / expired (signed in: "Send a new link", with the 5-an-hour limit; signed out: sign in first); a link
 * that does not open → the dead-link card.
 */
export function VerifyEmailForm({ token, viewer }: VerifyEmailFormProps) {
  const [phase, setPhase] = React.useState<Phase>(token ? { kind: "ready" } : { kind: "dead", reason: "invalid" });
  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const shownPhase = React.useRef(phase);

  // Move focus to the new state's heading so keyboard and screen-reader users hear what happened (never on load).
  React.useEffect(() => {
    if (shownPhase.current === phase) return;
    shownPhase.current = phase;
    headingRef.current?.focus();
  }, [phase]);

  const confirm = async () => {
    if (pending || !token || phase.kind !== "ready") return;
    setPending(true);
    setFormError(null);
    try {
      const result = await api.post<VerifyEmailResult>("/api/auth/verify-email", { token });
      setPhase({ kind: "confirmed", email: result.email, redirectTo: result.redirectTo || "/login", signedIn: result.signedIn });
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setPhase({ kind: "dead", reason: deadLinkReasonOf(err) });
      else if (err instanceof ApiError && err.status === 429) setFormError(`Too many tries in a short time. Try again in ${minutesLeft(retryAfterOf(err))}.`);
      else if (err instanceof ApiError && err.code === "network") setFormError("We couldn’t reach Proofline. Check your connection and try again.");
      else setFormError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  if (phase.kind === "ready") {
    // UX-20: someone signed in whose own address is already confirmed hears that straight away (the button stays,
    // quieter, for a link that belongs to another account opened in this browser).
    const alreadyConfirmed = viewer?.confirmed === true;
    return (
      <div className="flex flex-col gap-5" data-verify-state={alreadyConfirmed ? "ready_already_confirmed" : "ready"}>
        <Card className="shadow-md">
          <CardContent className="flex flex-col gap-4 p-6 first:pt-6 last:pb-6">
            {formError ? <FormAlert>{formError}</FormAlert> : null}
            <StateIcon tone={alreadyConfirmed ? "success" : "accent"} icon={alreadyConfirmed ? CircleCheck : MailCheck} />
            {alreadyConfirmed && viewer ? (
              <>
                <p className="text-sm text-ink-secondary">
                  You’re signed in as <span className="break-all font-medium text-ink">{viewer.email}</span>, and that email is already confirmed. You’re all set.
                </p>
                <Button href={viewer.homeHref} size="lg" className="w-full" trailingIcon={<ArrowRight aria-hidden="true" />}>
                  Continue
                </Button>
                <Button variant="ghost" size="sm" className="self-start" loading={pending} onClick={confirm} data-confirm-email="">
                  {pending ? "Confirming…" : "Confirm this link anyway"}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-secondary">Press the button to confirm the email address this link was sent to.</p>
                <Button size="lg" className="w-full" loading={pending} leadingIcon={<CircleCheck aria-hidden="true" />} onClick={confirm} data-confirm-email="">
                  {pending ? "Confirming…" : "Confirm my email"}
                </Button>
                <p className="text-xs text-ink-subtle">This only confirms your email. It doesn’t sign you in or change anything else.</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase.kind === "confirmed") {
    return (
      <StateCard
        state="confirmed"
        headingRef={headingRef}
        tone="success"
        icon={CircleCheck}
        title="Email confirmed"
        body={
          <>
            <span className="break-all font-medium text-ink">{phase.email}</span> is confirmed. You’re all set.
          </>
        }
        role="status"
      >
        <Button
          href={phase.redirectTo}
          size="lg"
          className="w-full"
          leadingIcon={phase.signedIn ? undefined : <LogIn aria-hidden="true" />}
          trailingIcon={phase.signedIn ? <ArrowRight aria-hidden="true" /> : undefined}
        >
          {phase.signedIn ? "Continue" : "Sign in"}
        </Button>
      </StateCard>
    );
  }

  const continueHref = viewer ? viewer.homeHref : "/login";

  if (phase.reason === "already_confirmed") {
    return (
      <StateCard
        state="already_confirmed"
        headingRef={headingRef}
        tone="success"
        icon={CircleCheck}
        title="This link has already been used"
        body="Your email is already confirmed, so you’re all set."
        role="status"
      >
        <Button href={continueHref} size="lg" className="w-full" trailingIcon={<ArrowRight aria-hidden="true" />}>
          Continue
        </Button>
      </StateCard>
    );
  }

  if (phase.reason === "invalid" && (!viewer || viewer.confirmed)) {
    return (
      <div data-verify-state="invalid" className="contents">
        <InvalidLinkCard
          title="This link didn’t work"
          body={VERIFY_DEAD_LINK_BODY}
          actionHref={viewer ? viewer.homeHref : "/login"}
          actionLabel={viewer ? "Continue" : "Go to sign in"}
        />
      </div>
    );
  }

  const copy: Record<Exclude<DeadLinkReason, "already_confirmed">, { title: string; body: string }> = {
    invalid: { title: "This link didn’t work", body: VERIFY_DEAD_LINK_BODY },
    used: {
      title: "This link has been replaced",
      body: "We sent a newer link after this one, so this one no longer works. Use the link in your most recent email from Proofline, or get a new one.",
    },
    expired: { title: "This link has expired", body: "Confirmation links work for 24 hours. Get a new one and open it within a day." },
  };
  const { title, body } = copy[phase.reason];

  return (
    <StateCard state={phase.reason} headingRef={headingRef} tone="attention" icon={Clock} title={title} body={body} role="alert">
      {viewer ? (
        viewer.confirmed ? (
          <>
            <p className="text-sm text-ink-muted">
              You’re signed in as <span className="break-all font-medium text-ink">{viewer.email}</span>, and that email is already confirmed.
            </p>
            <Button href={viewer.homeHref} size="lg" className="w-full" trailingIcon={<ArrowRight aria-hidden="true" />}>
              Continue
            </Button>
          </>
        ) : (
          <SendNewLink viewer={viewer} onConfirmed={() => setPhase({ kind: "dead", reason: "already_confirmed" })} />
        )
      ) : (
        <>
          <Button href="/login" size="lg" className="w-full" leadingIcon={<LogIn aria-hidden="true" />}>
            Sign in to get a new link
          </Button>
          <p className="text-xs text-ink-subtle">Once you’re signed in, press “Send again” at the top of the page or in your account.</p>
        </>
      )}
    </StateCard>
  );
}

/** "Send a new link" for the signed-in person (their own address), with its outcome shown inline. */
function SendNewLink({ viewer, onConfirmed }: { viewer: VerifyEmailViewer; onConfirmed: () => void }) {
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<ResendConfirmationOutcome | null>(null);

  const send = async () => {
    if (pending) return;
    setPending(true);
    const result = await requestNewConfirmationLink();
    setPending(false);
    if (result.kind === "already_confirmed") {
      onConfirmed();
      return;
    }
    setOutcome(result);
  };

  return (
    <div className="flex flex-col gap-3">
      {outcome?.kind === "sent" ? (
        <FormAlert tone="success">
          We sent a new link to <span className="break-all font-medium">{viewer.email}</span>. It works for 24 hours.
        </FormAlert>
      ) : outcome?.kind === "rate_limited" ? (
        <FormAlert tone="attention">You’ve asked for a lot of links in a short time. Try again in {outcome.wait}.</FormAlert>
      ) : outcome?.kind === "failed" ? (
        <FormAlert>{outcome.message}</FormAlert>
      ) : null}
      {outcome?.kind === "dev_link" ? <DevOnlyLink label="Confirmation link" url={outcome.url} /> : null}
      {outcome?.kind === "sent" || outcome?.kind === "dev_link" ? null : (
        <Button size="lg" className="w-full" loading={pending} leadingIcon={<Send aria-hidden="true" />} onClick={send} data-send-new-link="">
          {pending ? "Sending…" : "Send a new link"}
        </Button>
      )}
      <p className="text-xs text-ink-subtle">
        It goes to <span className="break-all">{viewer.email}</span>. Wrong address?{" "}
        <Link href={viewer.accountHref} className="font-medium text-accent-ink underline-offset-4 hover:underline">
          Change it in your account
        </Link>
        .
      </p>
    </div>
  );
}

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
type Tone = "accent" | "success" | "attention";

const TONE_CLASSES: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent-ink ring-accent/20",
  success: "bg-success-soft text-success ring-success/20",
  attention: "bg-attention-soft text-attention ring-attention/20",
};

function StateIcon({ tone, icon: Icon }: { tone: Tone; icon: IconComponent }) {
  return (
    <div className={cn("flex size-10 items-center justify-center rounded-full ring-1 ring-inset", TONE_CLASSES[tone])}>
      <Icon aria-hidden="true" className="size-5" />
    </div>
  );
}

interface StateCardProps {
  state: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  tone: Tone;
  icon: IconComponent;
  title: string;
  body: React.ReactNode;
  role: "status" | "alert";
  children?: React.ReactNode;
}

/** One outcome of the link: icon, heading (focused when it appears), plain-words body, the next step. */
function StateCard({ state, headingRef, tone, icon, title, body, role, children }: StateCardProps) {
  return (
    <div className="flex flex-col gap-5" data-verify-state={state}>
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-stretch gap-4 p-6 first:pt-6 last:pb-6">
          <StateIcon tone={tone} icon={icon} />
          <div role={role}>
            <h2 ref={headingRef} tabIndex={-1} className="text-md font-semibold text-ink outline-none">
              {title}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{body}</p>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}
