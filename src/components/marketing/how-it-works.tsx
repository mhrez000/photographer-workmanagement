import { STAGE_META, STAGE_TABS, type Stage } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { Section } from "./section";

/** One plain line per stage, in the words the app uses (docs/SIMPLIFICATION-PLAN.md §4). */
const STAGE_LINES: Partial<Record<Stage, string>> = {
  needs_editor: "You shot it. Pick an editor and hand it over.",
  with_editor: "The editor works from your raw files and pastes back a link.",
  ready_to_check: "Your turn. Open the photos, then approve or ask for changes.",
  changes_asked: "Your note goes straight to the editor. Round 2 comes back the same way.",
  done: "Finished. If the client uses the portal, they see it as delivered.",
};

const DOT: Record<string, string> = {
  grey: "bg-stage-grey",
  blue: "bg-stage-blue",
  amber: "bg-stage-amber",
  red: "bg-stage-red",
  green: "bg-stage-green",
};

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      heading="Five stages. One next button."
      lede="Every job is in exactly one stage and always says who it is waiting on. The happy path is four presses: Assign editor, Send for checking, Approve, done."
    >
      <ol className="relative mt-10 grid gap-6 sm:mt-12 lg:grid-cols-5 lg:gap-4">
        {/* The connecting line (desktop only) sits behind the dots. */}
        <div aria-hidden="true" className="absolute top-[11px] right-[10%] left-[10%] hidden h-px bg-border lg:block" />
        {STAGE_TABS.map((stage, i) => {
          const meta = STAGE_META[stage];
          return (
            <li key={stage} className="relative flex gap-4 lg:flex-col lg:gap-3">
              <div className="flex flex-col items-center lg:w-full lg:flex-row lg:justify-center">
                <span
                  className={cn(
                    "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-canvas",
                    DOT[meta.tone],
                  )}
                >
                  <span className="text-2xs font-semibold text-white">{i + 1}</span>
                </span>
                {/* Vertical connector on phones / tablets. */}
                {i < STAGE_TABS.length - 1 ? (
                  <span aria-hidden="true" className="mt-1 w-px flex-1 bg-border lg:hidden" />
                ) : null}
              </div>
              <div className="pb-2 lg:pb-0 lg:text-center">
                <p className="text-md font-semibold text-ink">{meta.label}</p>
                <p className="mt-1 text-sm text-ink-secondary">{STAGE_LINES[stage] ?? meta.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
