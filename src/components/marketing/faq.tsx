import * as React from "react";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { Section } from "./section";

const linkClass = "font-medium text-accent-ink underline-offset-4 hover:underline";

interface FaqProps {
  /** A signed-in visitor's own home and its words (UX-21): "How do I start?" then points there. */
  home?: { href: string; label: string } | null;
  /** The demo studio is open here (UX-07): only then does the answer offer it (at /login?demo=1). */
  demoOpen?: boolean;
}

function howToStart({ home = null, demoOpen = false }: FaqProps): React.ReactNode {
  if (home) {
    return (
      <>
        You are already in:{" "}
        <Link href={home.href} className={linkClass}>
          {home.label.toLowerCase()}
        </Link>
        . Owners add a job, invite an editor from Settings → People, and the job says what to press next.
      </>
    );
  }
  return (
    <>
      Press{" "}
      <Link href="/signup" className={linkClass}>
        Create your studio
      </Link>
      , give it a name and your email, and you are in. Add your first job, invite an editor from Settings → People, and
      the job tells you what to press next.
      {demoOpen ? (
        <>
          {" "}
          Want to look first?{" "}
          <Link href="/login?demo=1" className={linkClass}>
            See the demo
          </Link>
          .
        </>
      ) : null}
    </>
  );
}

const QUESTIONS: readonly { q: string; a: React.ReactNode }[] = [
  {
    q: "Is my data safe?",
    a: "Each studio is its own walled space; nobody outside your studio can see your jobs, people or clients. Passwords are stored hashed, invite and reset links expire, and every change to a job is written to a permanent history so you can always see who did what.",
  },
  {
    q: "Do editors see everything?",
    a: "No. An editor sees only the jobs you have given them: the raw files link, your instructions, your change requests and the messages on those jobs. They never see other editors' work, your clients list, or private notes.",
  },
  {
    q: "Can clients see unfinished work?",
    a: "No. A client only sees a job once you turn on “Client can see this job”, and they only see what you approved. Edits in progress, change requests and your messages with the editor stay between you and your editors.",
  },
  {
    q: "What does it cost?",
    a: "Nothing while Proofline is in early access. Create your studio, invite your editors and use everything. When pricing arrives you will hear about it well in advance, and early studios will not be caught out.",
  },
];

/** Five questions as native <details>: no JavaScript, keyboard-friendly, readable by search engines. */
export function Faq(props: FaqProps = {}) {
  const items = [...QUESTIONS, { q: "How do I start?", a: howToStart(props) }];
  return (
    <Section id="faq" eyebrow="Questions" heading="The questions studios ask first." centred>
      <div className="mx-auto mt-10 flex w-full max-w-2xl flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-xs sm:mt-12">
        {items.map((item) => (
          <details key={item.q} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm text-md font-medium text-ink focus-ring [&::-webkit-details-marker]:hidden">
              {item.q}
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-muted transition-transform duration-(--motion-base) group-open:rotate-180"
              />
            </summary>
            <p className="mt-3 text-base text-ink-secondary">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
