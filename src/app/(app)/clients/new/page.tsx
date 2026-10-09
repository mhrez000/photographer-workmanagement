import type { Metadata } from "next";
import { NewClientForm } from "@/components/production/client-form";
import { PageContainer } from "@/components/shell";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { guard, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "New client" };

/** Only same-app relative paths are allowed as a return target (no open redirects). */
function safeReturn(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  return value;
}

export default async function NewClientPage({ searchParams }: PageProps<"/clients/new">) {
  const { ctx } = await pageContext();
  guard(ctx, "client.create");
  const sp = await searchParams;
  const returnTo = safeReturn(param(sp, "returnTo"));

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow={[{ label: "Production" }, { label: "Clients", href: "/clients" }, { label: "New" }]}
        title="New client"
        description="Clients sit at the top of the structure: Client → Project → Jobs."
      />
      <Card>
        <CardContent className="pt-5">
          <NewClientForm returnTo={returnTo} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
