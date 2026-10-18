import Link from "next/link";
import { BrandMark } from "@/components/shell/brand-mark";
import { Container } from "./section";

const LINKS: readonly { href: string; label: string }[] = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#who-its-for", label: "Who it's for" },
  { href: "/#faq", label: "Questions" },
  { href: "/login", label: "Sign in" },
  { href: "/signup", label: "Create your studio" },
];

export function PublicFooter() {
  return (
    <footer className="border-t border-border bg-surface-sunken">
      <Container className="flex flex-col gap-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <BrandMark size={24} />
            <span className="text-[15px] font-semibold tracking-tight text-ink">Proofline</span>
          </div>
          <p className="max-w-xs text-sm text-ink-muted">The production desk for photography studios. Free while in early access.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="rounded-sm text-ink-secondary hover:text-ink focus-ring">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <Container className="border-t border-border/70 py-4 text-xs text-ink-subtle">
        © {new Date().getFullYear()} Proofline. Your photos stay wherever you keep them today.
      </Container>
    </footer>
  );
}
