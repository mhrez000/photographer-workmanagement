"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";

export interface CopyButtonProps {
  /** Text placed on the clipboard. */
  value: string;
  /** Visible label (omit for an icon-only button). */
  label?: string;
  /** Accessible name for the icon-only variant. */
  ariaLabel?: string;
  /** Toast text on success (null = no toast). */
  successMessage?: string | null;
  size?: "sm" | "md";
  variant?: "ghost" | "outline";
  className?: string;
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const el = document.createElement("textarea");
    el.value = value;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/** Copies a value (job number, link) with a brief ✓ confirmation. */
export function CopyButton({
  value,
  label,
  ariaLabel = "Copy",
  successMessage = "Copied to clipboard",
  size = "sm",
  variant = "ghost",
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const ok = await writeClipboard(value);
    if (ok) {
      setCopied(true);
      if (successMessage) toast.success(successMessage);
    } else {
      toast.error("Could not copy — your browser blocked clipboard access");
    }
  };

  const icon = copied ? <Check className="text-success" /> : <Copy />;

  if (!label) {
    return (
      <IconButton label={copied ? "Copied" : ariaLabel} size={size === "sm" ? "xs" : "sm"} variant={variant} onClick={copy} className={className}>
        {icon}
      </IconButton>
    );
  }
  return (
    <Button size={size} variant={variant} leadingIcon={icon} onClick={copy} className={className}>
      {copied ? "Copied" : label}
    </Button>
  );
}
