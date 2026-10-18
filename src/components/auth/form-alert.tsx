import * as React from "react";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export type FormAlertTone = "danger" | "attention" | "success" | "neutral";

export interface FormAlertProps {
  tone?: FormAlertTone;
  children: React.ReactNode;
  className?: string;
  /** `status` for calm confirmations; `alert` (default for problems). */
  role?: "alert" | "status";
}

type IconComponent = React.ComponentType<{ className?: string; "aria-hidden"?: "true" }>;

const TONES: Record<FormAlertTone, { box: string; icon: string; Icon: IconComponent }> = {
  danger: { box: "border-danger/30 bg-danger-soft", icon: "text-danger", Icon: CircleAlert },
  attention: { box: "border-attention/30 bg-attention-soft", icon: "text-attention", Icon: Clock },
  success: { box: "border-success/30 bg-success-soft", icon: "text-success", Icon: CircleCheck },
  neutral: { box: "border-border bg-surface-sunken", icon: "text-ink-muted", Icon: CircleAlert },
};

/** Form-level message box, matching the sign-in page's error strip. */
export function FormAlert({ tone = "danger", children, className, role }: FormAlertProps) {
  const { box, icon, Icon } = TONES[tone];
  const liveRole = role ?? (tone === "success" || tone === "neutral" ? "status" : "alert");
  return (
    <div role={liveRole} className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm text-ink", box, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", icon)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
