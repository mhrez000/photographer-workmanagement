import { Camera, Eye, Wand2 } from "lucide-react";
import { Section } from "./section";

const ROLES = [
  {
    icon: Camera,
    title: "Owner / Photographer",
    line: "Create jobs, give them to editors, check the edits, approve. Owners also look after people and clients.",
    sees: "Owners see everything. Extra photographers see only the shoots they did.",
  },
  {
    icon: Wand2,
    title: "Editor",
    line: "Open the raw files, edit, paste the finished link, press Send for checking. Fix changes when asked.",
    sees: "Editors see only the jobs given to them. Nothing else.",
  },
  {
    icon: Eye,
    title: "Client",
    line: "A simple portal: see where their job is, open the finished photos, leave feedback.",
    sees: "Clients see only their own jobs, and only once you say they can.",
  },
] as const;

export function WhoItsFor() {
  return (
    <Section id="who-its-for" eyebrow="Who it's for" heading="Three roles, in plain words." className="bg-surface-sunken">
      <ul className="mt-10 grid gap-4 sm:mt-12 md:grid-cols-3">
        {ROLES.map((role) => (
          <li key={role.title} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 shadow-xs">
            <span className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
              <role.icon aria-hidden="true" className="size-4.5" />
            </span>
            <h3 className="text-md font-semibold text-ink">{role.title}</h3>
            <p className="text-sm text-ink-secondary">{role.line}</p>
            <p className="mt-auto border-t border-border pt-3 text-sm text-ink-muted">{role.sees}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
