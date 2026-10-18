import type { Metadata } from "next";
import { AuthPageHeader } from "@/components/auth/auth-page-header";
import { hasSignedUp } from "@/server/auth/signed-up";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /login. The demo-accounts box (the seeded studio's four logins) shows by default on this dev / demo
 * deployment, but not where it would read as someone else's credentials: `?from=invite` (an invitee sent
 * here from their invite page) and a browser that has created a real studio (`pl_signed_up` cookie) hide it.
 * `?demo=1` ("See the demo" on the landing page) always shows it, first and highlighted.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = firstParam(params.next);
  const expired = firstParam(params.expired) !== undefined;
  const demo = firstParam(params.demo) !== undefined;
  const fromInvite = firstParam(params.from) === "invite";
  // Prefill from "Sign in instead" on the sign-up page (bounded; never trusted beyond the field value).
  const email = firstParam(params.email)?.slice(0, 254);
  const showDemo = demo || (!fromInvite && !(await hasSignedUp()));

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader
        title={demo ? "Look around the demo studio" : "Sign in to Proofline"}
        lede={demo ? "Pick one of the demo accounts below; the password fills in for you." : "Use the email and password your studio gave you."}
      />
      <LoginForm next={next} expired={expired} initialEmail={email} showDemo={showDemo} demoFirst={demo} />
    </div>
  );
}
