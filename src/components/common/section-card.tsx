import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface SectionCardProps extends Omit<React.ComponentPropsWithRef<"section">, "title"> {
  title?: React.ReactNode;
  /** Small uppercase label above the title. */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header actions (buttons, links, a count). */
  actions?: React.ReactNode;
  /** Footer row (e.g. "View all →"). */
  footer?: React.ReactNode;
  /** Remove body padding (tables / lists that run edge to edge). */
  flush?: boolean;
  tone?: "default" | "muted" | "accent" | "attention" | "danger";
  /** Heading level for the title (default h2). */
  as?: "h2" | "h3";
  bodyClassName?: string;
}

/** A titled card section: header (eyebrow, title, description, actions), body, optional footer. */
export function SectionCard({
  title,
  eyebrow,
  description,
  actions,
  footer,
  flush = false,
  tone = "default",
  as: Heading = "h2",
  className,
  bodyClassName,
  children,
  id,
  ...props
}: SectionCardProps) {
  const headingId = id ? `${id}-title` : undefined;
  const hasHeader = Boolean(title || eyebrow || description || actions);
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className={cn("min-w-0", className)} {...props}>
      <Card tone={tone} className="h-full overflow-hidden">
        {hasHeader ? (
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
              {title ? (
                <Heading id={headingId} className="text-md font-semibold leading-6 text-ink">
                  {title}
                </Heading>
              ) : null}
              {description ? <p className="mt-0.5 text-sm text-ink-muted">{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
        <div className={cn("min-w-0 flex-1", flush ? (hasHeader ? "border-t border-border" : "") : "px-5 pb-5", !hasHeader && !flush && "pt-5", bodyClassName)}>
          {children}
        </div>
        {footer ? <div className="border-t border-border bg-surface-sunken/60 px-5 py-3 text-sm">{footer}</div> : null}
      </Card>
    </section>
  );
}
