"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Camera, Crown, Store, Wand2, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError } from "@/lib/api-client";
import { DEMO_PERSONAS, type DemoPersona } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { minutesLeft, retryAfterOf } from "./auth-helpers";
import { FormAlert } from "./form-alert";

/** One button per persona: who you will be, in one plain line. No emails, no passwords — ever. */
export const DEMO_PERSONA_COPY: Readonly<Record<DemoPersona, { title: string; line: string; icon: LucideIcon }>> = {
  owner: { title: "Owner", line: "Runs the studio: shoots, gives jobs to editors and checks the edits.", icon: Crown },
  photographer: { title: "Photographer", line: "Shoots for the studio and sees only their own jobs.", icon: Camera },
  editor: { title: "Editor", line: "Edits the jobs given to them and sends them back to be checked.", icon: Wand2 },
  client: { title: "Client", line: "A client following their jobs and getting the finished photos.", icon: Store },
};

interface DemoSignInResult {
  redirectTo: string;
}

export interface DemoPanelProps {
  /** `/login?demo=1` (from "See the demo studio"): the panel comes first, highlighted and scrolled into view. */
  highlighted?: boolean;
}

/**
 * "Look around the demo" on the sign-in page (docs/ACCOUNTS.md §7): one button per persona → POST /api/auth/demo →
 * signed in to the shared demo studio as that person → their landing page. The page renders this only when demo
 * sign-in is available on this deployment (`demoSignInAvailable`).
 */
export function DemoPanel({ highlighted = false }: DemoPanelProps) {
  const router = useRouter();
  const ref = React.useRef<HTMLElement>(null);
  const [pending, setPending] = React.useState<DemoPersona | null>(null);
  const [error, setError] = React.useState<{ tone: "danger" | "attention"; text: string } | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [highlighted]);

  const signIn = async (persona: DemoPersona) => {
    if (pending) return;
    setPending(persona);
    setError(null);
    try {
      // A 401 here is not "your session ended": that persona can't be opened right now (DEMO-01) — say so in place.
      const result = await api.post<DemoSignInResult>("/api/auth/demo", { persona }, { redirectOn401: false });
      // Stay "pending" until the next page takes over, so nobody presses twice.
      router.push(result.redirectTo || "/home");
    } catch (err) {
      setPending(null);
      if (err instanceof ApiError && err.status === 429) {
        setError({ tone: "attention", text: `Too many demo sign-ins from this network. Try again in ${minutesLeft(retryAfterOf(err))}.` });
      } else if (err instanceof ApiError && err.status === 404) {
        setError({ tone: "danger", text: "The demo studio isn’t open right now. Sign in with your own account, or create your studio." });
      } else if (err instanceof ApiError && err.status === 401) {
        setError({ tone: "attention", text: `The demo isn’t open as ${DEMO_PERSONA_COPY[persona].title} right now. Try someone else.` });
      } else {
        setError({ tone: "danger", text: "Something went wrong. Please try again." });
      }
    }
  };

  return (
    <section
      ref={ref}
      id="demo"
      aria-labelledby={titleId}
      aria-busy={pending ? true : undefined}
      data-demo-panel=""
      data-highlighted={highlighted ? "" : undefined}
      className={cn(
        "scroll-mt-6 rounded-lg border p-4",
        highlighted ? "border-accent/50 bg-accent-soft/40 shadow-xs" : "border-dashed border-border bg-surface-sunken",
      )}
    >
      <h2 id={titleId} className="text-sm font-semibold text-ink">
        Look around the demo
      </h2>
      <p className="mt-1 text-sm text-ink-muted">A shared studio full of sample jobs. Pick who to be — no password needed. Anyone can see changes made there.</p>

      {error ? (
        <FormAlert tone={error.tone} className="mt-3">
          {error.text}
        </FormAlert>
      ) : null}

      <ul className="mt-3 flex flex-col gap-2">
        {DEMO_PERSONAS.map((persona) => {
          const copy = DEMO_PERSONA_COPY[persona];
          const Icon = copy.icon;
          const busy = pending === persona;
          return (
            <li key={persona}>
              <button
                type="button"
                onClick={() => void signIn(persona)}
                disabled={pending !== null}
                data-demo-persona={persona}
                className={cn(
                  "group flex min-h-12 w-full items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-left shadow-xs transition-colors duration-(--motion-fast)",
                  "hover:border-border-hover hover:bg-surface-muted focus-ring disabled:cursor-not-allowed",
                  pending !== null && !busy && "opacity-60",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink" aria-hidden="true">
                  {busy ? <Spinner size="xs" className="text-current" /> : <Icon className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{busy ? `Opening the demo as ${copy.title}…` : `Look around as ${copy.title}`}</span>
                  <span className="block text-xs text-ink-muted">
                    {copy.line}
                  </span>
                </span>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle transition-transform duration-(--motion-fast) group-hover:translate-x-0.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
