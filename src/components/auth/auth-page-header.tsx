import * as React from "react";
import { BrandMark } from "@/components/shell/brand-mark";

export interface AuthPageHeaderProps {
  title: React.ReactNode;
  /** One plain sentence under the title. */
  lede?: React.ReactNode;
}

/**
 * The heading block every front-door page starts with. On phones the side panel (brand + pitch) is hidden,
 * so the mark comes with the wordmark: someone who has never heard of Proofline at least learns its name.
 */
export function AuthPageHeader({ title, lede }: AuthPageHeaderProps) {
  return (
    <div className="flex flex-col items-start gap-4">
      <span className="flex items-center gap-2.5 lg:hidden">
        <BrandMark size={36} />
        <span className="text-base font-semibold tracking-tight text-ink">Proofline</span>
      </span>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {lede ? <p className="mt-1.5 text-base text-ink-muted">{lede}</p> : null}
      </div>
    </div>
  );
}
