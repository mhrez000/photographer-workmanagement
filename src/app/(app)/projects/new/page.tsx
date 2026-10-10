import type { Metadata } from "next";
import { Building2, Plus } from "lucide-react";
import { NewProjectForm } from "@/components/production/project-form";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { getClientOptions } from "@/server/queries/options";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage({ searchParams }: PageProps<"/projects/new">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "project.create");
  const sp = await searchParams;
  const clients = await load(() => getClientOptions(db, ctx));
  const defaultClientId = param(sp, "clientId");
  const canCreateClient = allowed(ctx, "client.create");
  const client = defaultClientId ? clients.find((c) => c.id === defaultClientId) : undefined;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow={[
          { label: "Production" },
          { label: "Projects", href: "/projects" },
          ...(client ? [{ label: client.name, href: `/clients/${client.id}` }] : []),
          { label: "New" },
        ]}
        title="New project"
        description="A project is usually one property or shoot. Add its jobs — photography, editing, twilight, floor plan — once it exists."
      />
      <Card>
        {clients.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Add a client first"
            description="Every project belongs to a client. Create the agency or brand, then come back to add the project."
            action={
              canCreateClient ? (
                <Button href="/clients/new?returnTo=/projects/new" leadingIcon={<Plus aria-hidden="true" />}>
                  New client
                </Button>
              ) : null
            }
          />
        ) : (
          <CardContent className="pt-5">
            <NewProjectForm clients={clients} defaultClientId={defaultClientId} canCreateClient={canCreateClient} />
          </CardContent>
        )}
      </Card>
    </PageContainer>
  );
}
