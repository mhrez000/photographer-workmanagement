import * as React from "react";
import {
  Aperture,
  Box,
  Clapperboard,
  Cloud,
  ExternalLink,
  HardDrive,
  Images,
  Link2,
  Send,
  type LucideIcon,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { LINK_PROVIDER_LABELS, LINK_PROVIDERS, type LinkProvider } from "@/lib/constants";
import { deriveLinkProvider, isAllowedLinkUrl } from "@/lib/validation/links";
import { cn } from "@/lib/utils";

const PROVIDER_ICONS: Record<LinkProvider, LucideIcon> = {
  drive: HardDrive,
  dropbox: Box,
  onedrive: Cloud,
  frameio: Clapperboard,
  wetransfer: Send,
  lightroom: Aperture,
  pixieset: Images,
  other: Link2,
};

function asProvider(value: string | null | undefined): LinkProvider | null {
  return value && (LINK_PROVIDERS as readonly string[]).includes(value) ? (value as LinkProvider) : null;
}

/** Provider for a stored value, or derived from the URL host. */
export function resolveProvider(provider: string | null | undefined, url?: string | null): LinkProvider {
  return asProvider(provider) ?? (url ? deriveLinkProvider(url) : "other");
}

/** "drive.google.com" from a URL (no www.), or null when unparsable. */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface LinkProviderIconProps {
  provider?: LinkProvider | string | null;
  /** Used to derive the provider when `provider` is missing. */
  url?: string | null;
  className?: string;
}

/** Neutral glyph for an external storage provider (Drive, Dropbox, Frame.io, …). */
export function LinkProviderIcon({ provider, url, className }: LinkProviderIconProps) {
  const p = resolveProvider(provider, url);
  const Icon = PROVIDER_ICONS[p];
  return <Icon aria-label={LINK_PROVIDER_LABELS[p]} role="img" className={cn("size-4 shrink-0", className)} />;
}

export interface ExternalLinkButtonProps {
  url: string;
  /** Visible label; defaults to the provider name. */
  label?: string | null;
  provider?: LinkProvider | string | null;
  size?: "sm" | "md";
  variant?: "outline" | "ghost" | "secondary";
  /** Hide the host caption (tight layouts). */
  hideHost?: boolean;
  className?: string;
}

/**
 * Opens an external link in a new tab (`rel="noopener noreferrer"`), with the
 * provider glyph, label and host so people see where they are going. Non
 * http(s) URLs render as inert text — never as a clickable link.
 */
export function ExternalLinkButton({
  url,
  label,
  provider,
  size = "sm",
  variant = "outline",
  hideHost = false,
  className,
}: ExternalLinkButtonProps) {
  const p = resolveProvider(provider, url);
  const host = linkHost(url);
  const text = label?.trim() || LINK_PROVIDER_LABELS[p];

  if (!isAllowedLinkUrl(url)) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-sm text-ink-subtle", className)} title={url}>
        <Link2 aria-hidden="true" className="size-4" />
        <span className="truncate">{text}</span>
        <span className="text-2xs">(unsupported link)</span>
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className={cn(buttonVariants({ variant, size }), "min-w-0 max-w-full justify-start", className)}
    >
      <LinkProviderIcon provider={p} />
      <span className="truncate">{text}</span>
      {!hideHost && host ? <span className="hidden truncate text-xs font-normal text-ink-subtle sm:inline">{host}</span> : null}
      <ExternalLink aria-hidden="true" className="ml-auto text-ink-subtle" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
