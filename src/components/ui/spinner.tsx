import { cn } from "@/lib/utils";

const sizes = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-5",
  lg: "size-7",
} as const;

export interface SpinnerProps {
  size?: keyof typeof sizes;
  className?: string;
  /** Screen-reader label. */
  label?: string;
}

/** Indeterminate activity indicator. */
export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <span role="status" className={cn("inline-flex shrink-0", className)}>
      <svg
        className={cn("animate-spin text-current", sizes[size])}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
