import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container } from "./section";

/** `home` = a signed-in visitor's landing page and its words (UX-11): one button instead of Create / Sign in. */
export function ClosingCta({ home = null }: { home?: { href: string; label: string } | null } = {}) {
  return (
    <section aria-labelledby="closing-heading" className="py-14 sm:py-20">
      <Container>
        <div className="flex flex-col items-center gap-5 rounded-xl border border-accent/20 bg-accent-soft/60 px-5 py-10 text-center sm:px-10 sm:py-14">
          <h2 id="closing-heading" className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Ready when you are.
          </h2>
          <p className="max-w-md text-md text-ink-secondary">A studio takes a minute to set up. Your first job takes less.</p>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            {home ? (
              <Button href={home.href} size="lg" trailingIcon={<ArrowRight aria-hidden="true" />}>
                {home.label}
              </Button>
            ) : (
              <>
                <Button href="/signup" size="lg" trailingIcon={<ArrowRight aria-hidden="true" />}>
                  Create your studio
                </Button>
                <Button href="/login" size="lg" variant="outline">
                  Sign in
                </Button>
              </>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
