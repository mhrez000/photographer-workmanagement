import * as React from "react";
import { cn } from "@/lib/utils";

export interface FormSectionProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Small trailing element in the heading column (e.g. "3 of 5 editable"). */
  aside?: React.ReactNode;
}

/**
 * Settings-style form section: heading + explanation in a narrow left column,
 * fields on the right (stacked on small screens). Sections are separated by
 * hairlines.
 */
export function FormSection({ title, description, aside, className, children, ...props }: FormSectionProps) {
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid gap-x-10 gap-y-4 border-t border-border py-7 first:border-t-0 first:pt-0 lg:grid-cols-[15rem_minmax(0,1fr)]", className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 id={headingId} className="text-md font-semibold leading-6 text-ink">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
        {aside ? <div className="mt-2">{aside}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}
