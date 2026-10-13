import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OwnerHome } from "@/lib/types";
import { cn } from "@/lib/utils";
import { firstName, greetingAt } from "./greeting";

export interface HomeToplineProps {
  home: OwnerHome;
  timeZone: string;
  canCreate: boolean;
  className?: string;
}

function Part({ href, count, word, tone }: { href: string; count: number; word: string; tone: "attention" | "danger" | "neutral" }) {
  const colour = count === 0 ? "text-ink-muted" : tone === "danger" ? "text-danger-fg" : tone === "attention" ? "text-attention-fg" : "text-ink";
  return (
    <Link href={href} className={cn("rounded-xs font-semibold underline-offset-4 hover:underline focus-ring", colour)}>
      <span className="numeric">{count}</span> {word}
    </Link>
  );
}

/**
 * "Good morning, Mo. 3 to check · 2 late · 1 needs an editor." — each part links to that Jobs tab,
 * with the big + New job on the right (docs/SIMPLIFICATION-PLAN.md §6).
 */
export function HomeTopline({ home, timeZone, canCreate, className }: HomeToplineProps) {
  const { toCheck, late, needsEditor } = home.topline;
  const nothing = toCheck === 0 && late === 0 && needsEditor === 0;
  return (
    <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold leading-8 tracking-tight text-ink">
          {greetingAt(new Date(home.asOf), timeZone)}
          {home.viewer.name ? `, ${firstName(home.viewer.name)}` : ""}.
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-ink-secondary">
          {nothing ? (
            <span>Nothing is waiting on you right now.</span>
          ) : (
            <>
              <Part href="/jobs?stage=ready_to_check" count={toCheck} word="to check" tone="attention" />
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <Part href="/jobs?late=1" count={late} word="late" tone="danger" />
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <Part href="/jobs?stage=needs_editor" count={needsEditor} word={needsEditor === 1 ? "needs an editor" : "need an editor"} tone="neutral" />
            </>
          )}
        </p>
      </div>
      {canCreate ? (
        <Button href="/jobs/new" size="lg" leadingIcon={<Plus aria-hidden="true" />} className="shrink-0 self-start">
          New job
        </Button>
      ) : null}
    </header>
  );
}
