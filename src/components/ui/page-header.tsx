import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  label: React.ReactNode;
  href?: string;
}

export interface PageHeaderProps extends Omit<React.ComponentPropsWithRef<"header">, "title"> {
  /** Small uppercase label above the title, or a breadcrumb trail. */
  eyebrow?: React.ReactNode | BreadcrumbItem[];
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, menus). */
  actions?: React.ReactNode;
  /** Optional back link rendered before the eyebrow. */
  backHref?: string;
  backLabel?: string;
  /** Content under the header (tabs, filter bar). */
  children?: React.ReactNode;
  /** Inline badge/status next to the title. */
  meta?: React.ReactNode;
}

function isBreadcrumb(value: PageHeaderProps["eyebrow"]): value is BreadcrumbItem[] {
  return Array.isArray(value);
}

/** Page title block with eyebrow/breadcrumb, description and an actions slot. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  backHref,
  backLabel = "Back",
  meta,
  children,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4", className)} {...props}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          {backHref ? (
            <Link
              href={backHref}
              className="mb-2 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink focus-ring rounded-xs"
            >
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              {backLabel}
            </Link>
          ) : null}
          {eyebrow ? (
            isBreadcrumb(eyebrow) ? (
              <nav aria-label="Breadcrumb" className="mb-1.5">
                <ol className="flex flex-wrap items-center gap-1 eyebrow">
                  {eyebrow.map((item, index) => {
                    const last = index === eyebrow.length - 1;
                    return (
                      <li key={index} className="flex items-center gap-1">
                        {item.href && !last ? (
                          <Link href={item.href} className="hover:text-ink focus-ring rounded-xs">
                            {item.label}
                          </Link>
                        ) : (
                          <span aria-current={last ? "page" : undefined} className={cn(last && "text-ink-secondary")}>
                            {item.label}
                          </span>
                        )}
                        {!last ? (
                          <ChevronRight aria-hidden="true" className="size-3 text-ink-subtle" />
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </nav>
            ) : (
              <div className="mb-1.5 eyebrow">{eyebrow}</div>
            )
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold leading-8 text-ink">{title}</h1>
            {meta}
          </div>
          {description ? (
            <p className="mt-1 max-w-2xl text-base text-ink-muted">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
