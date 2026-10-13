import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BrandMark } from "@/components/shell/brand-mark";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-canvas px-4 py-16">
      <BrandMark size={36} className="mb-8" />
      <EmptyState
        icon={Compass}
        title="We can't find that page"
        description="It may have been moved, or the link might be out of date. Head back home and we'll get you going again."
        action={
          <>
            <Button href="/">Go home</Button>
            <Button variant="outline" href="/jobs">
              Browse jobs
            </Button>
          </>
        }
        size="lg"
      />
      <p className="mt-8 font-mono text-2xs uppercase tracking-wider text-ink-subtle">Error 404</p>
    </div>
  );
}
