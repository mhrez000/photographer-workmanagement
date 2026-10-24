import * as React from "react";
import { LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface InvalidLinkCardProps {
  /**
   * A heading inside the card. Leave it out when the page's own header already says what happened (UX-14: one heading
   * per page) — the body then carries the card.
   */
  title?: string;
  body: React.ReactNode;
  actionHref: string;
  actionLabel: string;
  /** A quiet line under the card for a SECOND way forward (never the same place as the button). */
  footer?: React.ReactNode;
}

/** A dead invite / reset / confirm link: friendly, with the one obvious next step. Works in server components. */
export function InvalidLinkCard({ title, body, actionHref, actionLabel, footer }: InvalidLinkCardProps) {
  return (
    <div className="flex flex-col gap-5" data-invalid-link="">
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
            <LinkIcon aria-hidden="true" className="size-5" />
          </div>
          <div role="alert">
            {title ? <h2 className="text-md font-semibold text-ink">{title}</h2> : null}
            <p className={title ? "mt-1 text-sm text-ink-muted" : "text-sm text-ink-secondary"}>{body}</p>
          </div>
          <Button href={actionHref} size="lg" className="w-full">
            {actionLabel}
          </Button>
        </CardContent>
      </Card>
      {footer ? <p className="text-center text-sm text-ink-muted">{footer}</p> : null}
    </div>
  );
}
