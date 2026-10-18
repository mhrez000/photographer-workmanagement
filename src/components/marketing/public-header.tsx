import Link from "next/link";
import { BrandMark } from "@/components/shell/brand-mark";
import { Button } from "@/components/ui/button";
import { Container } from "./section";

/** Public chrome: brand on the left, Sign in + Create your studio on the right. No app shell. */
export function PublicHeader() {
  return (
    <header className="sticky top-0 z-(--z-topbar) border-b border-border/80 bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/70">
      <Container className="flex h-14 items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 rounded-sm focus-ring" aria-label="Proofline — home">
          <BrandMark size={28} />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Proofline</span>
        </Link>
        <nav aria-label="Account" className="flex items-center gap-1.5 sm:gap-2">
          <Button href="/login" variant="ghost" size="sm">
            Sign in
          </Button>
          <Button href="/signup" size="sm">
            Create your studio
          </Button>
        </nav>
      </Container>
    </header>
  );
}
