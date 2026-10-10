import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Not found" };

/** Portal 404: unshared, other clients' and unknown jobs all look the same (docs/ROLES.md §7.2). */
export default function PortalNotFound() {
  return (
    <EmptyState
      icon={Compass}
      bordered
      size="lg"
      title="We can't find that"
      description="It may no longer be shared with you, or the link is out of date. Everything your studio shares is on Your work."
      action={<Button href="/portal">Go to your work</Button>}
    />
  );
}
