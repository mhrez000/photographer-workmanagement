import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EditorNumberMeta } from "./numbers";

export interface NumberLabelProps {
  meta: EditorNumberMeta;
  align?: "start" | "center" | "end";
  className?: string;
  /** Extra classes for the tooltip bubble (responsive alignment overrides, see FiveNumbers). */
  tooltipClassName?: string;
}

/**
 * A number's name with its one-line explanation on hover or tap (docs/SIMPLIFICATION-PLAN.md §7: "Each
 * number has a one-line explanation when you hover or tap it"). The trigger is a real button so a tap on
 * a phone focuses it and shows the tooltip.
 */
export function NumberLabel({ meta, align = "center", className, tooltipClassName }: NumberLabelProps) {
  return (
    <Tooltip content={meta.help} align={align} className={tooltipClassName}>
      <button
        type="button"
        className={cn(
          "inline-flex cursor-help items-center gap-1 rounded-xs text-left underline decoration-dotted decoration-border-strong underline-offset-4 hover:decoration-ink-muted focus-ring",
          className,
        )}
      >
        {meta.label}
      </button>
    </Tooltip>
  );
}
