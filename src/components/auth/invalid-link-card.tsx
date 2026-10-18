import * as React from "react";
import Link from "next/link";
import { LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface InvalidLinkCardProps {
  title: string;
  body: React.ReactNode;
  actionHref: string;
  actionLabel: string;
}

/** A dead invite / reset link: friendly, with the one obvious next step. Works in server components. */
export function InvalidLinkCard({ title, body, actionHref, actionLabel }: InvalidLinkCardProps) {
  return (
    <div className="flex flex-col gap-5">
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
            <LinkIcon aria-hidden="true" className="size-5" />
          </div>
          <div role="alert">
            <h2 className="text-md font-semibold text-ink">{title}</h2>
            <p className="mt-1 text-sm text-ink-muted">{body}</p>
          </div>
          <Button href={actionHref} size="lg" className="w-full">
            {actionLabel}
          </Button>
        </CardContent>
      </Card>
      <p className="text-center text-sm text-ink-muted">
        Already have a password?{" "}
        <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
