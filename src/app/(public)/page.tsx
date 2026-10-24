import type { Metadata } from "next";
import { homeLabelFor } from "@/components/auth/auth-helpers";
import { ClosingCta, Faq, Hero, HowItWorks, NotStorage, Screenshots, WhoItsFor } from "@/components/marketing";
import { getDb } from "@/db/index";
import { demoSignInAvailable } from "@/server/auth/demo";
import { getViewer } from "@/server/auth/session";
import { appOrigin } from "@/server/origin";
import { homePathFor } from "@/server/page";

const TITLE = "Proofline — the production desk for photography studios";
const DESCRIPTION =
  "Shoot, give it to an editor, check it, done. One list of jobs, five plain stages, and every job says who it is waiting on. Free while in early access.";

export const metadata: Metadata = {
  metadataBase: new URL(appOrigin()),
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Proofline",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/marketing/og.png", width: 1200, height: 630, alt: "Proofline — the production desk for photography studios" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/marketing/og.png"],
  },
  robots: { index: true, follow: true },
};

/**
 * The landing page — for everyone. A signed-in visitor sees it too (docs/ACCOUNTS.md §1); the (public) layout's header
 * then offers one button back to their own home instead of "Sign in" / "Create your studio" — and so do the hero, the
 * FAQ, the footer and the closing call to action, in words that fit them ("Go to your studio" / "Go to my jobs" /
 * "See your work", UX-11 / UX-21). The demo is only offered where it is open (UX-07: `demoSignInAvailable`).
 */
export default async function LandingPage() {
  const viewer = await getViewer();
  const home = viewer ? { href: homePathFor({ role: viewer.role }), label: homeLabelFor(viewer.role) } : null;
  const demoOpen = home ? false : await demoSignInAvailable(getDb());
  return (
    <>
      <Hero home={home} demoOpen={demoOpen} />
      <HowItWorks />
      <WhoItsFor />
      <Screenshots />
      <NotStorage />
      <Faq home={home} demoOpen={demoOpen} />
      <ClosingCta home={home} />
    </>
  );
}
