import * as React from "react";
import { cn } from "@/lib/utils";

/** Shared horizontal gutter for every landing section (16 px on phones, never wider than 1120 px). */
export function Container({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("mx-auto w-full max-w-[1120px] px-4 sm:px-6 lg:px-8", className)} {...props} />;
}

export interface SectionProps extends React.ComponentPropsWithRef<"section"> {
  /** Small uppercase line above the heading. */
  eyebrow?: string;
  heading?: React.ReactNode;
  lede?: React.ReactNode;
  /** Centre the heading block (default: left-aligned). */
  centred?: boolean;
}

/** A landing section: eyebrow + heading + optional lede, then whatever the section shows. */
export function Section({ eyebrow, heading, lede, centred = false, className, children, id, ...props }: SectionProps) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={heading ? headingId : undefined}
      className={cn("scroll-mt-20 py-14 sm:py-20", className)}
      {...props}
    >
      <Container>
        {heading ? (
          <div className={cn("flex max-w-2xl flex-col gap-3", centred && "mx-auto items-center text-center")}>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 id={headingId} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              {heading}
            </h2>
            {lede ? <p className="text-md text-ink-secondary sm:text-lg">{lede}</p> : null}
          </div>
        ) : null}
        {children}
      </Container>
    </section>
  );
}
