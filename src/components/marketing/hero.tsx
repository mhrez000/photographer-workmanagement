import Image from "next/image";
import Link from "next/link";
import { ArrowRight, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DesktopFrame } from "./device-frame";
import { Container } from "./section";

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden pt-14 pb-10 sm:pt-20 sm:pb-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-soft)_0%,transparent_70%)]"
      />
      <Container className="flex flex-col items-center text-center">
        <p className="eyebrow">For photographers and their editors</p>
        <h1
          id="hero-heading"
          className="mt-4 max-w-3xl text-[2rem] leading-[1.1] font-semibold tracking-tight text-ink sm:text-5xl sm:leading-[1.05]"
        >
          The production desk for photography studios.
        </h1>
        <p className="mt-5 max-w-xl text-md text-ink-secondary sm:text-lg">
          Shoot, give it to an editor, check it, done. One list of jobs, five plain stages, and every job says who it is
          waiting on.
        </p>
        <div className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
          <Button href="/signup" size="lg" trailingIcon={<ArrowRight aria-hidden="true" />}>
            Create your studio
          </Button>
          <Button href="/login" size="lg" variant="outline" leadingIcon={<LogIn aria-hidden="true" />}>
            Sign in
          </Button>
        </div>
        <Link
          href="/login?demo=1"
          className="mt-4 rounded-sm text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline focus-ring"
        >
          See the demo studio
        </Link>
        <p className="mt-3 text-xs text-ink-subtle">Free while in early access · No card needed</p>

        <DesktopFrame
          className="mt-12 w-full max-w-[960px] sm:mt-16"
          title="Home — Northlight Studios (demo)"
          caption="Home for the owner of the demo studio, on a busy day: the three counts at the top, then every job that is ready to check with its two buttons."
        >
          <Image
            src="/marketing/home-desktop.png"
            alt="The Proofline Home screen: a greeting, three counts (to check, late, need an editor) and a list of jobs that are ready to check, each with Approve and Ask for changes buttons."
            width={1200}
            height={483}
            priority
            sizes="(min-width: 1024px) 960px, 100vw"
            className="block h-auto w-full"
          />
        </DesktopFrame>
      </Container>
    </section>
  );
}
