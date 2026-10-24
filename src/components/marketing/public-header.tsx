import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "@/components/shell/brand-mark";
import { Button } from "@/components/ui/button";
import { Container } from "./section";

export interface PublicHeaderProps {
  /** The signed-in person on this browser (null / omitted = a visitor); `homeLabel` fits their role (UX-11). */
  account?: { name: string; homeHref: string; homeLabel?: string } | null;
}

/**
 * Public chrome: brand on the left; on the right "Sign in" + "Create your studio" for visitors, or one "Go to your
 * studio" button for someone already signed in (docs/ACCOUNTS.md §1). No app shell.
 */
export function PublicHeader({ account = null }: PublicHeaderProps) {
  return (
    <header className="sticky top-0 z-(--z-topbar) border-b border-border/80 bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/70">
      <Container className="flex h-14 items-center justify-between gap-3">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-sm focus-ring" aria-label="Proofline — home">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Proofline</span>
        </Link>
        <nav aria-label="Account" className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          {account ? (
            <>
              <span className="hidden truncate text-sm text-ink-muted md:inline" data-signed-in-as="">
                Signed in as <span className="font-medium text-ink">{account.name}</span>
              </span>
              <Button href={account.homeHref} size="sm" trailingIcon={<ArrowRight aria-hidden="true" />} data-go-to-studio="">
                {account.homeLabel ?? "Go to your studio"}
              </Button>
            </>
          ) : (
            <>
              <Button href="/login" variant="ghost" size="sm">
                Sign in
              </Button>
              <Button href="/signup" size="sm">
                Create your studio
              </Button>
            </>
          )}
        </nav>
      </Container>
    </header>
  );
}
