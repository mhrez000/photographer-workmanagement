import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input, type InputProps } from "./input";

export interface DateInputProps extends Omit<InputProps, "type" | "leading"> {
  /** ISO date string `YYYY-MM-DD` for min/max are passed straight through. */
  variant?: "date" | "datetime-local" | "time";
}

/**
 * Native date picker, styled. Values are `YYYY-MM-DD` strings — convert
 * to/from ISO UTC with the helpers in `src/lib/dates.ts`.
 */
export function DateInput({ variant = "date", className, ...props }: DateInputProps) {
  return (
    <Input
      type={variant}
      leading={<CalendarDays aria-hidden="true" />}
      className={cn("numeric cursor-pointer", className)}
      {...props}
    />
  );
}
