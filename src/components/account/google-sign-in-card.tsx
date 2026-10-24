import * as React from "react";
import { SectionCard } from "@/components/common/section-card";
import { GoogleLogo } from "@/components/auth/google-logo";
import type { AccountSecurityOverview } from "@/lib/types";
import { GoogleSignInControls } from "./google-sign-in-controls";

/**
 * The "Google" sign-in method on Settings → My account and /portal/account (docs/ACCOUNTS.md §4). `id="google"` is
 * where a Connect round trip comes back to (`?google=connected#google`).
 *
 *   connected       "Connected as <google_email>" + Disconnect (only with a password; else "set a password first")
 *   not connected   Connect Google → your password → POST /api/auth/google/connect → Google (only when Google is
 *                   configured; SEC-03)
 *   neither         nothing at all (Google off and never connected)
 *
 * The demo studio never gets here (AccountSecuritySection shows its one read-only notice instead).
 */
export function GoogleSignInCard({ overview }: { overview: AccountSecurityOverview }) {
  const { configured, connected, email } = overview.google;
  if (!configured && !connected) return null;
  return (
    <SectionCard
      id="google"
      title="Google"
      description="Sign in with your Google account instead of typing a password."
      actions={<GoogleLogo className="size-4" />}
      data-google-card={connected ? "connected" : "not-connected"}
    >
      {/* The controls read `?google=` (useSearchParams): their own Suspense boundary keeps the rest of the page streaming. */}
      <React.Suspense fallback={null}>
        <GoogleSignInControls
          configured={configured}
          connected={connected}
          googleEmail={email}
          hasPassword={overview.hasPassword}
        />
      </React.Suspense>
    </SectionCard>
  );
}
