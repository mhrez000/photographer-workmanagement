import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ChevronRight, Plus, SearchX } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { CountCell } from "@/components/production/counts";
import { ListToolbar } from "@/components/production/list-toolbar";
import { PageContainer } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { listClients } from "@/server/queries/clients";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "client.view");
  const sp = await searchParams;
  const q = param(sp, "q")?.trim() || undefined;
  const includeArchived = param(sp, "archived") === "1";
  const tz = ctx.settings.timezone;
  const clients = load(() => listClients(db, ctx, { q, includeArchived }));
  const canCreate = allowed(ctx, "client.create");
  const filtered = Boolean(q || includeArchived);

  const totals = clients.reduce(
    (acc, c) => ({ open: acc.open + c.counts.open, overdue: acc.overdue + c.counts.overdue }),
    { open: 0, overdue: 0 },
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Production"
        title="Clients"
        description={
          clients.length > 0 ? (
            <span className="numeric">
              {clients.length} client{clients.length === 1 ? "" : "s"} · {totals.open} open job{totals.open === 1 ? "" : "s"}
              {totals.overdue > 0 ? <span className="text-danger-fg"> · {totals.overdue} overdue</span> : null}
            </span>
          ) : (
            "The agencies, brands and people you shoot for."
          )
        }
        actions={
          canCreate ? (
            <Button href="/clients/new" leadingIcon={<Plus aria-hidden="true" />}>
              New client
            </Button>
          ) : null
        }
      >
        <ListToolbar searchPlaceholder="Search clients, contacts, emails…" />
      </PageHeader>

      {clients.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No clients match"
              description={q ? `Nothing found for “${q}”. Try a contact name or email, or include archived clients.` : "There are no archived clients."}
              action={
                <Button href="/clients" variant="outline" size="sm">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Building2}
              title={ctx.role === "editor" ? "No clients on your jobs yet" : "No clients yet"}
              description={
                ctx.role === "editor"
                  ? "Clients appear here once you're assigned a job for them."
                  : "Add the agencies and brands you work with, then group their shoots into projects."
              }
              action={
                canCreate ? (
                  <Button href="/clients/new" leadingIcon={<Plus aria-hidden="true" />}>
                    Add your first client
                  </Button>
                ) : null
              }
            />
          )}
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <div className="hidden md:block">
            <Table density="default">
              <THead>
                <tr>
                  <TH>Client</TH>
                  <TH>Contact</TH>
                  <TH numeric>Projects</TH>
                  <TH numeric>Open jobs</TH>
                  <TH numeric>Overdue</TH>
                  <TH numeric>Completed</TH>
                  <TH>Last activity</TH>
                </tr>
              </THead>
              <TBody>
                {clients.map(({ client, counts, projectCount }) => (
                  <TR key={client.id} interactive className={client.archivedAt ? "opacity-70" : undefined}>
                    <TD primary className="max-w-[18rem]">
                      <Link href={`/clients/${client.id}`} className="flex min-w-0 items-center gap-2.5 rounded-xs focus-ring">
                        <Avatar name={client.name} colour={client.colour} size="sm" shape="rounded" />
                        <span className="truncate hover:underline underline-offset-2">{client.name}</span>
                        {client.archivedAt ? (
                          <Badge size="sm" variant="outline">
                            Archived
                          </Badge>
                        ) : null}
                      </Link>
                    </TD>
                    <TD muted className="max-w-[14rem]">
                      {client.contactName || client.email ? (
                        <div className="min-w-0">
                          <div className="truncate text-ink-secondary">{client.contactName ?? client.email}</div>
                          {client.contactName && client.email ? <div className="truncate text-xs">{client.email}</div> : null}
                        </div>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </TD>
                    <TD numeric>
                      <CountCell value={projectCount} />
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.open} />
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.overdue} tone="danger" />
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.completed} />
                    </TD>
                    <TD muted>
                      {counts.lastActivityAt ? <RelativeTime value={counts.lastActivityAt} timeZone={tz} /> : <span className="text-ink-subtle">—</span>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="divide-y divide-border md:hidden">
            {clients.map(({ client, counts, projectCount }) => (
              <li key={client.id}>
                <Link href={`/clients/${client.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface-muted focus-ring">
                  <Avatar name={client.name} colour={client.colour} size="md" shape="rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{client.name}</span>
                      {client.archivedAt ? (
                        <Badge size="sm" variant="outline">
                          Archived
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted numeric">
                      <span>{projectCount} project{projectCount === 1 ? "" : "s"}</span>
                      <span>{counts.open} open</span>
                      {counts.overdue > 0 ? <span className="font-medium text-danger-fg">{counts.overdue} overdue</span> : null}
                      {counts.lastActivityAt ? <RelativeTime value={counts.lastActivityAt} timeZone={tz} /> : null}
                    </div>
                  </div>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
