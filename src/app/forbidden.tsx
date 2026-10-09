import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = {
  title: "Access restricted",
};

export default function Forbidden() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to this"
        description="Your role doesn't include this area. If you think you should be able to see it, ask a studio owner or manager to update your permissions."
        action={
          <>
            <Button href="/dashboard">Back to dashboard</Button>
            <Button variant="outline" href="/workspace/my">
              Go to My Work
            </Button>
          </>
        }
        size="lg"
      />
      <p className="mt-8 font-mono text-2xs uppercase tracking-wider text-ink-subtle">Error 403</p>
    </div>
  );
}
