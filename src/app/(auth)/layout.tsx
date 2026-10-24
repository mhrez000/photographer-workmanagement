import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/shell";

/**
 * One line for each kind of person who lands here (UX-13): an owner signing in, an editor or a client opening their
 * invite — the panel is true for all of them, never an owner-only pitch.
 */
const HIGHLIGHTS = [
  "Studios: one list of jobs, five plain stages, one next button",
  "Editors: the jobs given to you, with everything you need to start",
  "Clients: follow your shoot and get the finished photos in one place",
];

/** Public auth chrome: brand panel (desktop) + centred form column. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh flex-1 bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-surface-sunken lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-semibold tracking-tight text-ink">Proofline</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-2xl font-semibold leading-tight tracking-tight text-ink">
            Where a photography studio, its editors and its clients keep every job.
          </h2>
          <ul className="mt-6 flex flex-col gap-3">
            {HIGHLIGHTS.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-base text-ink-secondary">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-ink-muted">Needs editor · With editor · Ready to check · Changes asked · Done</p>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -bottom-24 size-80 rounded-full border-[28px] border-accent/10"
        />
      </aside>
      <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
