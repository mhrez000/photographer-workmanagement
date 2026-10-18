import type { Metadata } from "next";
import { ClosingCta, Faq, Hero, HowItWorks, NotStorage, Screenshots, WhoItsFor } from "@/components/marketing";
import { appOrigin } from "@/server/origin";

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

/** The landing page. Anonymous visitors only; the (public) layout sends a signed-in person to their home. */
export default function LandingPage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <WhoItsFor />
      <Screenshots />
      <NotStorage />
      <Faq />
      <ClosingCta />
    </>
  );
}
