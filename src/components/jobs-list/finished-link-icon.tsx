import { Images } from "lucide-react";
import type { SimpleLink } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface FinishedLinkIconProps {
  link: SimpleLink | null;
  /** Accessible / tooltip label (default "Open finished photos"). */
  label?: string;
  className?: string;
}

/** Small icon that opens the editor's finished photos in a new tab (nothing when there is no link yet). */
export function FinishedLinkIcon({ link, label = "Open finished photos", className }: FinishedLinkIconProps) {
  if (!link) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink focus-ring",
        className,
      )}
    >
      <Images aria-hidden="true" className="size-4" />
    </a>
  );
}
