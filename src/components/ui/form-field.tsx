import * as React from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

export interface FormFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FormFieldProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Error message — when present the field is marked invalid. */
  error?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  hint?: React.ReactNode;
  /** Explicit control id; otherwise generated. */
  id?: string;
  className?: string;
  /**
   * The control. Either a single element (we inject `id`, `aria-*`)
   * or a render function receiving the props to spread.
   */
  children: React.ReactElement<Record<string, unknown>> | ((props: FormFieldControlProps) => React.ReactNode);
}

/**
 * Label + description + control + error, wired together with the right
 * ARIA attributes. Works in server components.
 */
export function FormField({
  label,
  description,
  error,
  required,
  optional,
  hint,
  id,
  className,
  children,
}: FormFieldProps) {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const descId = `${controlId}-description`;
  const errorId = `${controlId}-error`;

  const describedBy = [description ? descId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");

  const controlProps: FormFieldControlProps = {
    id: controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": required ? true : undefined,
  };

  const control =
    typeof children === "function"
      ? children(controlProps)
      : React.cloneElement(children, {
          ...controlProps,
          ...(error ? { invalid: true } : {}),
        });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <Label htmlFor={controlId} required={required} optional={optional} hint={hint}>
          {label}
        </Label>
      ) : null}
      {control}
      {description && !error ? (
        <p id={descId} className="text-sm text-ink-muted">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
