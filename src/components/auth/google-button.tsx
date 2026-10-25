"use client";

import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { GoogleLogo } from "./google-logo";

export interface GoogleButtonProps {
  /** GET /api/auth/google/start?… (`googleStartHref`). A real navigation: Google's page replaces this one. */
  href: string;
  /** Google's approved wording: "Continue with Google" (default), "Sign in with Google", "Sign up with Google". */
  label?: string;
  size?: "md" | "lg";
  /** Full width of the form column (default) or as wide as the words. */
  fullWidth?: boolean;
  className?: string;
}

/**
 * The "Continue with Google" button, per Google's branding guidelines: the standard four-colour G on the left, the
 * approved words, a plain light surface with a thin border (the design system's outline button). A link, not a
 * fetch: pressing it shows "Opening Google…" and ignores further presses until the page changes (coming back with
 * the browser's Back button re-enables it).
 */
export function GoogleButton({ href, label = "Continue with Google", size = "lg", fullWidth = true, className }: GoogleButtonProps) {
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    // Back from Google (bfcache) restores this page as it was: make the button usable again.
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    // A new tab / window keeps this page as it is.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setPending(true);
  };

  return (
    <a
      href={href}
      onClick={onClick}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      rel="nofollow"
      data-google-button=""
      // The button sizes icons to 16 px; Google's mark stays at its 20 px (a more specific selector than [&_svg]).
      className={cn(buttonVariants({ variant: "outline", size }), "gap-2.5 [&_svg[data-google-logo]]:size-5", fullWidth && "w-full", pending && "cursor-progress", className)}
    >
      <GoogleLogo />
      <span>{pending ? "Opening Google…" : label}</span>
      {pending ? <Spinner size="sm" label="Opening Google" className="text-ink-muted" /> : null}
    </a>
  );
}
