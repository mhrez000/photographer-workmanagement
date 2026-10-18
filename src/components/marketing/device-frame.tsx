import * as React from "react";
import { cn } from "@/lib/utils";

export interface FrameProps extends React.ComponentPropsWithRef<"figure"> {
  /** Window title shown in the fake title bar (desktop only). */
  title?: string;
  caption?: React.ReactNode;
}

/** A browser-window frame around a desktop screenshot. The image keeps its own aspect ratio, so nothing shifts. */
export function DesktopFrame({ title, caption, className, children, ...props }: FrameProps) {
  return (
    <figure className={cn("flex flex-col gap-3", className)} {...props}>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-pop">
        <div className="flex h-9 items-center gap-2 border-b border-border bg-surface-sunken px-3">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
            <span className="size-2.5 rounded-full bg-border-strong" />
          </span>
          {title ? <span className="mx-auto truncate text-xs text-ink-muted">{title}</span> : null}
          <span aria-hidden="true" className="w-9" />
        </div>
        {children}
      </div>
      {caption ? <figcaption className="text-sm text-ink-muted">{caption}</figcaption> : null}
    </figure>
  );
}

/** A phone bezel around a 390 px wide screenshot. */
export function PhoneFrame({ caption, className, children, ...props }: Omit<FrameProps, "title">) {
  return (
    <figure className={cn("flex flex-col items-center gap-3", className)} {...props}>
      <div className="w-full max-w-[300px] overflow-hidden rounded-[2rem] border-[6px] border-ink/90 bg-ink/90 shadow-pop dark:border-border-strong dark:bg-border-strong">
        <div className="overflow-hidden rounded-[1.6rem] bg-surface">{children}</div>
      </div>
      {caption ? <figcaption className="max-w-[300px] text-center text-sm text-ink-muted">{caption}</figcaption> : null}
    </figure>
  );
}
