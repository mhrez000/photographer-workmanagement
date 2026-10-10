import type { Metadata } from "next";
import {
  AlertCircle,
  ArrowRight,
  Briefcase,
  CalendarClock,
  Camera,
  CircleCheck,
  Clock,
  Download,
  Ellipsis,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
  Users,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GATES, type NavGates } from "@/config/nav";
import { AppShell, PageContainer } from "@/components/shell";
import { Avatar, AvatarGroup } from "@/components/ui/avatar";
import {
  Badge,
  PRIORITIES,
  PRIORITY_META,
  PriorityBadge,
  STATUS_CATEGORIES,
  STATUS_META,
  StatusBadge,
} from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { KpiCard } from "@/components/ui/kpi-card";
import { PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton, SkeletonCards, SkeletonTable, SkeletonText } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import {
  CheckboxDemo,
  DialogDemo,
  DropdownDemo,
  LoadingButtonDemo,
  SearchDemo,
  SheetDemo,
  SortableTableDemo,
  SwitchDemo,
  TabsDemo,
  ToastDemo,
} from "./demos";

export const metadata: Metadata = {
  title: "Design system",
  description: "Every Proofline primitive in every state, for visual QA.",
};

const demoUser = {
  id: "demo",
  name: "Alex Morgan",
  email: "alex@studio.test",
  role: "photographer" as const,
  isAdmin: true,
};

/** Every nav gate open: the demo shell shows the full Owner / Photographer navigation. */
const DEMO_NAV_GATES = Object.fromEntries(NAV_GATES.map((g) => [g, true])) as NavGates;

const SECTIONS = [
  ["tokens", "Tokens"],
  ["status", "Status & priority"],
  ["typography", "Typography"],
  ["buttons", "Buttons"],
  ["forms", "Forms"],
  ["badges", "Badges & avatars"],
  ["cards", "Cards & KPIs"],
  ["table", "Table"],
  ["tabs", "Tabs & segmented"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback & states"],
  ["header", "Page header"],
] as const;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, className, label }: { name: string; className: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("h-12 rounded-md border border-border", className)} />
      <div className="text-xs font-medium text-ink">{label ?? name}</div>
      <div className="font-mono text-2xs text-ink-subtle">{name}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[140px_1fr] sm:items-center">
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export default function DesignSystemPage() {
  return (
    <AppShell user={demoUser} orgName="Northlight Studio" unreadCount={7} navGates={DEMO_NAV_GATES} viewScope="business">
      <PageContainer>
        <PageHeader
          eyebrow="Internal"
          title="Design system"
          description="Every primitive, every variant. Light and dark follow the OS unless <html> has .dark / data-theme."
          actions={
            <>
              <Button variant="outline" leadingIcon={<Download aria-hidden="true" />}>
                Export tokens
              </Button>
              <Button leadingIcon={<Plus aria-hidden="true" />}>New job</Button>
            </>
          }
        >
          <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary hover:border-border-hover hover:text-ink focus-ring"
              >
                {label}
              </a>
            ))}
          </nav>
        </PageHeader>

        {/* ---------------------------------------------------------- */}
        <Section id="tokens" title="Tokens" description="Surfaces, ink, accent and semantic colours. All defined in src/app/globals.css.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            <Swatch name="bg-canvas" className="bg-canvas" />
            <Swatch name="bg-surface" className="bg-surface" />
            <Swatch name="bg-surface-muted" className="bg-surface-muted" />
            <Swatch name="bg-surface-sunken" className="bg-surface-sunken" />
            <Swatch name="bg-ink" className="bg-ink" />
            <Swatch name="bg-ink-muted" className="bg-ink-muted" />
            <Swatch name="bg-accent" className="bg-accent" />
            <Swatch name="bg-accent-soft" className="bg-accent-soft" />
            <Swatch name="bg-attention" className="bg-attention" />
            <Swatch name="bg-attention-soft" className="bg-attention-soft" />
            <Swatch name="bg-success" className="bg-success" />
            <Swatch name="bg-success-soft" className="bg-success-soft" />
            <Swatch name="bg-warning" className="bg-warning" />
            <Swatch name="bg-warning-soft" className="bg-warning-soft" />
            <Swatch name="bg-danger" className="bg-danger" />
            <Swatch name="bg-danger-soft" className="bg-danger-soft" />
            <Swatch name="bg-info" className="bg-info" />
            <Swatch name="bg-info-soft" className="bg-info-soft" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <div className="text-xs font-medium text-ink-muted">Shadows</div>
              <div className="mt-3 flex gap-3">
                {(["shadow-xs", "shadow-sm", "shadow-md", "shadow-pop"] as const).map((s) => (
                  <div key={s} className={cn("flex h-12 flex-1 items-end justify-center rounded-md bg-surface pb-1 font-mono text-2xs text-ink-subtle", s)}>
                    {s.replace("shadow-", "")}
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs font-medium text-ink-muted">Radii</div>
              <div className="mt-3 flex items-end gap-3">
                {(["rounded-xs", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl"] as const).map((r) => (
                  <div key={r} className={cn("flex size-12 items-center justify-center border border-border-strong bg-surface-muted font-mono text-2xs text-ink-subtle", r)}>
                    {r.replace("rounded-", "")}
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs font-medium text-ink-muted">Motion</div>
              <div className="mt-3 flex flex-col gap-2 text-xs text-ink-secondary">
                <div className="flex justify-between"><span>--motion-fast</span><span className="font-mono">120ms</span></div>
                <div className="flex justify-between"><span>--motion-base</span><span className="font-mono">180ms</span></div>
                <div className="flex justify-between"><span>--motion-slow</span><span className="font-mono">280ms</span></div>
                <div className="mt-1 flex gap-2">
                  <span className="animate-fade-in rounded-sm bg-accent-soft px-2 py-0.5 text-accent-ink">fade-in</span>
                  <span className="animate-slide-up rounded-sm bg-accent-soft px-2 py-0.5 text-accent-ink">slide-up</span>
                </div>
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs font-medium text-ink-muted">Focus ring & numerals</div>
              <div className="mt-3 flex flex-col gap-3">
                <Input defaultValue="Tab to me for the ring" size="sm" />
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-ink-muted">proportional<br />1,234,567.89</div>
                  <div className="numeric text-ink">tabular<br />1,234,567.89</div>
                </div>
              </div>
            </Card>
          </div>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="status" title="Status & priority" description="13 workflow status categories and 4 priority levels as named tokens: bg-status-{key}, bg-status-{key}-soft, text-status-{key}-fg.">
          <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Status palette</CardTitle>
                  <CardDescription>Soft pills for tables, solid for kanban column headers, dots for compact rows.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid gap-x-8 gap-y-3 2xl:grid-cols-2">
                  {STATUS_CATEGORIES.map((key) => (
                    <div key={key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className={cn("size-2.5 shrink-0 rounded-full", STATUS_META[key].dot)} />
                      <StatusBadge status={key} />
                      <StatusBadge status={key} solid size="sm" hideDot />
                      <code className="ml-auto font-mono text-2xs text-ink-subtle">{key}</code>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Priority</CardTitle>
                  <CardDescription>Signal bars scale with urgency.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {PRIORITIES.map((key) => (
                  <div key={key} className="flex items-center justify-between gap-6">
                    <PriorityBadge priority={key} />
                    <div className="flex items-center gap-3">
                      <PriorityBadge priority={key} compact />
                      <span className={cn("size-2.5 rounded-full", PRIORITY_META[key].dot)} />
                      <code className="font-mono text-2xs text-ink-subtle">{key}</code>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="typography" title="Typography" description="Geist Sans for everything, Geist Mono for ids and code. 14px base, 13px in tables.">
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="text-4xl font-semibold tracking-tight">Display 36 — Northlight Studio</div>
              <div className="text-3xl font-semibold tracking-tight">Heading 30 — 42 active jobs</div>
              <div className="text-2xl font-semibold">Heading 24 — Page title</div>
              <div className="text-xl font-semibold">Heading 20 — Section title</div>
              <div className="text-lg font-semibold">Heading 17 — Dialog title</div>
              <div className="text-md font-medium">Body 15 — Card title / emphasised row</div>
              <div className="text-base">Body 14 — Default UI text. Jordan changed status from Assigned to In Progress.</div>
              <div className="text-sm text-ink-secondary">Small 13 — Table cells and secondary copy with tabular numerals: 1,024 · 12.5%</div>
              <div className="text-xs text-ink-muted">Caption 12 — Meta information, timestamps, hints.</div>
              <div className="eyebrow">Eyebrow 11 — Group label</div>
              <div className="font-mono text-sm">PJ-0142 · mono 13 · 2026-10-08T23:41:00Z</div>
            </CardContent>
          </Card>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="buttons" title="Buttons" description="Six variants, four sizes, loading and disabled states. Pass href to get a Link.">
          <Card>
            <CardContent className="flex flex-col gap-5">
              <Row label="Variants">
                <Button>Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="link">Link</Button>
              </Row>
              <Row label="Sizes">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button size="icon" aria-label="Settings">
                  <Settings aria-hidden="true" />
                </Button>
              </Row>
              <Row label="With icons">
                <Button leadingIcon={<Plus aria-hidden="true" />}>New job</Button>
                <Button variant="outline" trailingIcon={<ArrowRight aria-hidden="true" />}>
                  Continue
                </Button>
                <Button variant="ghost" size="sm" leadingIcon={<Pencil aria-hidden="true" />}>
                  Edit
                </Button>
                <Button variant="danger" size="sm" leadingIcon={<Trash2 aria-hidden="true" />}>
                  Delete
                </Button>
              </Row>
              <Row label="States">
                <Button loading>Saving…</Button>
                <Button variant="outline" loading size="sm">
                  Loading
                </Button>
                <Button disabled>Disabled</Button>
                <Button variant="outline" disabled>
                  Disabled
                </Button>
                <LoadingButtonDemo />
              </Row>
              <Row label="As links">
                <Button href="/dashboard">Go to dashboard</Button>
                <Button href="/jobs" variant="outline">
                  Browse jobs
                </Button>
                <Button href="/jobs" variant="link">
                  View all →
                </Button>
                <Button href="/jobs" disabled>
                  Disabled link
                </Button>
              </Row>
              <Row label="Icon buttons">
                <IconButton label="Edit">
                  <Pencil />
                </IconButton>
                <IconButton label="More" variant="outline">
                  <Ellipsis />
                </IconButton>
                <IconButton label="Settings" variant="secondary">
                  <Settings />
                </IconButton>
                <IconButton label="Add" variant="primary">
                  <Plus />
                </IconButton>
                <IconButton label="Delete" variant="danger">
                  <Trash2 />
                </IconButton>
                <IconButton label="Small" size="sm" variant="outline">
                  <Search />
                </IconButton>
                <IconButton label="Extra small" size="xs">
                  <Ellipsis />
                </IconButton>
                <IconButton label="Large" size="lg" variant="outline">
                  <Camera />
                </IconButton>
                <IconButton label="Loading" loading variant="outline">
                  <Plus />
                </IconButton>
              </Row>
              <Row label="Keyboard">
                <Kbd keys={["⌘", "K"]} />
                <Kbd>Esc</Kbd>
                <Kbd size="md" keys={["Ctrl", "Enter"]} />
                <span className="text-sm text-ink-muted">
                  Press <Kbd>g</Kbd> then <Kbd>j</Kbd> to jump to Jobs
                </span>
              </Row>
            </CardContent>
          </Card>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="forms" title="Forms" description="Native elements, consistent chrome, proper ARIA wiring via FormField.">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Inputs</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <FormField label="Job name" required description="Shown on the kanban card and in notifications.">
                  <Input placeholder="123 Smith Street" />
                </FormField>
                <FormField label="Client email" error="Enter a valid email address.">
                  <Input type="email" defaultValue="not-an-email" />
                </FormField>
                <FormField label="Gallery link" optional hint="External URLs only">
                  <Input type="url" placeholder="https://" leading={<Search aria-hidden="true" />} />
                </FormField>
                <div className="grid grid-cols-3 gap-3">
                  <Input size="sm" placeholder="Small" />
                  <Input size="md" placeholder="Medium" />
                  <Input size="lg" placeholder="Large" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input placeholder="Disabled" disabled />
                  <Input defaultValue="Read only" readOnly />
                </div>
                <Input mono defaultValue="PJ-0142" trailing={<span className="text-xs">ID</span>} />
                <FormField label="Shoot date">
                  <DateInput defaultValue="2026-10-14" />
                </FormField>
                <FormField label="Job type">
                  <Select
                    placeholder="Select a type"
                    defaultValue=""
                    options={[
                      { value: "real-estate", label: "Real estate" },
                      { value: "portrait", label: "Portrait" },
                      { value: "commercial", label: "Commercial" },
                      { value: "event", label: "Event", disabled: true },
                    ]}
                  />
                </FormField>
                <FormField label="Photographer notes" description="Visible to the editor.">
                  <Textarea placeholder="Twilight exteriors need sky replacement…" />
                </FormField>
              </CardContent>
            </Card>
            <div className="flex flex-col gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Search</CardTitle>
                </CardHeader>
                <CardContent>
                  <SearchDemo />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Checkboxes</CardTitle>
                </CardHeader>
                <CardContent>
                  <CheckboxDemo />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Switches</CardTitle>
                </CardHeader>
                <CardContent>
                  <SwitchDemo />
                </CardContent>
              </Card>
            </div>
          </div>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="badges" title="Badges & avatars">
          <Card>
            <CardContent className="flex flex-col gap-5">
              <Row label="Badge variants">
                <Badge>Neutral</Badge>
                <Badge variant="accent">Accent</Badge>
                <Badge variant="success">Success</Badge>
                <Badge variant="warning">Warning</Badge>
                <Badge variant="danger">Danger</Badge>
                <Badge variant="info">Info</Badge>
                <Badge variant="attention">Attention</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="solid">Solid</Badge>
              </Row>
              <Row label="With dot / small">
                <Badge dot variant="success">
                  Healthy
                </Badge>
                <Badge dot variant="warning">
                  Near capacity
                </Badge>
                <Badge dot variant="danger">
                  Overloaded
                </Badge>
                <Badge size="sm">12</Badge>
                <Badge size="sm" variant="accent">
                  New
                </Badge>
              </Row>
              <Row label="Avatar sizes">
                <Avatar name="Alex Morgan" size="xs" />
                <Avatar name="Priya Nair" size="sm" />
                <Avatar name="Tom Becker" size="md" />
                <Avatar name="Mei Lin" size="lg" />
                <Avatar name="Jordan Blake" size="xl" />
                <Avatar name="Harcourts Newtown" size="lg" shape="rounded" />
                <Avatar name="Custom Colour" size="lg" colour="#0f766e" />
              </Row>
              <Row label="Presence">
                <Avatar name="Alex Morgan" status="online" />
                <Avatar name="Priya Nair" status="away" />
                <Avatar name="Tom Becker" status="busy" />
                <Avatar name="Mei Lin" status="offline" />
              </Row>
              <Row label="Group">
                <AvatarGroup
                  items={[
                    { name: "Alex Morgan" },
                    { name: "Priya Nair" },
                    { name: "Tom Becker" },
                    { name: "Mei Lin" },
                    { name: "Jordan Blake" },
                    { name: "Sam Ortiz" },
                    { name: "Ava Chen" },
                  ]}
                  max={4}
                />
                <AvatarGroup size="md" items={[{ name: "Alex Morgan" }, { name: "Priya Nair" }]} />
              </Row>
              <Row label="Tooltip">
                <Tooltip content="Edit job details">
                  <IconButton label="Edit" variant="outline">
                    <Pencil />
                  </IconButton>
                </Tooltip>
                <Tooltip content="Right side" side="right">
                  <Button variant="outline" size="sm">
                    Hover or focus me
                  </Button>
                </Tooltip>
                <Tooltip content="Below" side="bottom">
                  <Button variant="ghost" size="sm">
                    Bottom
                  </Button>
                </Tooltip>
              </Row>
            </CardContent>
          </Card>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="cards" title="Cards & KPIs" description="Dashboard tiles use tabular numerals and a sentiment-coloured delta.">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Active jobs" value="42" delta={{ value: "+6", direction: "up" }} sub="vs last week" icon={Briefcase} href="/jobs" />
            <KpiCard label="Due today" value="7" tone="accent" icon={CalendarClock} sub="3 awaiting editor" />
            <KpiCard label="Overdue" value="3" tone="danger" delta={{ value: "+1", direction: "up", sentiment: "negative" }} icon={AlertCircle} />
            <KpiCard label="Awaiting review" value="5" tone="attention" icon={Clock} sub="Oldest: 2 days" />
            <KpiCard label="In editing" value="18" icon={WandSparkles} delta={{ value: "0", direction: "flat" }} />
            <KpiCard label="Revision required" value="2" tone="danger" icon={TriangleAlert} />
            <KpiCard label="Completed this week" value="23" tone="success" icon={CircleCheck} delta={{ value: "+18%", direction: "up" }} />
            <KpiCard label="Loading" value="—" loading sub="…" icon={Users} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Editor workload</CardTitle>
                  <CardDescription>This week</CardDescription>
                </div>
                <CardActions>
                  <IconButton label="More" size="sm">
                    <Ellipsis />
                  </IconButton>
                </CardActions>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {[
                  ["Priya Nair", 3, "success"],
                  ["Tom Becker", 5, "success"],
                  ["Mei Lin", 8, "warning"],
                  ["Chris Wade", 11, "danger"],
                ].map(([name, count, tone]) => (
                  <div key={String(name)} className="flex items-center gap-3">
                    <Avatar name={String(name)} size="sm" />
                    <span className="flex-1 truncate text-sm">{name}</span>
                    <Progress value={Number(count)} max={12} size="xs" tone={tone as "success" | "warning" | "danger"} className="w-24" label={`${name} workload`} />
                    <span className="numeric w-6 text-right text-sm text-ink-muted">{count}</span>
                  </div>
                ))}
              </CardContent>
              <CardFooter>
                <span>4 editors</span>
                <Button variant="link" size="sm" href="/team/workloads">
                  View workloads
                </Button>
              </CardFooter>
            </Card>
            <Card interactive tabIndex={0}>
              <CardHeader>
                <div>
                  <CardTitle>Interactive card</CardTitle>
                  <CardDescription>Lifts on hover, focus-visible ring.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <SkeletonText lines={3} />
              </CardContent>
            </Card>
            <div className="flex flex-col gap-4">
              <Card tone="attention" className="p-4">
                <div className="flex items-start gap-3">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
                  <div className="text-sm">
                    <div className="font-medium text-ink">Needs attention</div>
                    <div className="text-ink-secondary">2 jobs have been in review for more than 48 hours.</div>
                  </div>
                </div>
              </Card>
              <Card tone="accent" className="p-4 text-sm">
                <div className="font-medium text-ink">Accent tone</div>
                <div className="text-ink-secondary">Used sparingly for highlights.</div>
              </Card>
              <Card tone="muted" className="p-4 text-sm">
                <div className="font-medium text-ink">Muted tone</div>
                <div className="text-ink-secondary">Sunken background for secondary panels.</div>
              </Card>
            </div>
          </div>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="table" title="Table" description="13px, tabular numerals, sticky header, sortable columns, row selection, compact density.">
          <SortableTableDemo />
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="tabs" title="Tabs & segmented control" description="Arrow keys move between tabs and segments.">
          <Card>
            <CardContent>
              <TabsDemo />
            </CardContent>
          </Card>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="overlays" title="Overlays" description="Dialog and Sheet use the native <dialog> element; menus and popovers close on Escape and outside click.">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Dialog</CardTitle>
              </CardHeader>
              <CardContent>
                <DialogDemo />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sheet</CardTitle>
              </CardHeader>
              <CardContent>
                <SheetDemo />
              </CardContent>
            </Card>
            <Card id="dropdown">
              <CardHeader>
                <CardTitle>Dropdown menu & popover</CardTitle>
              </CardHeader>
              <CardContent>
                <DropdownDemo />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Toasts</CardTitle>
              </CardHeader>
              <CardContent>
                <ToastDemo />
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="feedback" title="Feedback & states" description="Loading, empty and error states every list page must have.">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Skeletons</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <Skeleton circle className="size-10" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                </div>
                <SkeletonTable rows={4} columns={4} />
                <SkeletonCards count={2} columns={2} />
              </CardContent>
            </Card>
            <div className="flex flex-col gap-4">
              <Card>
                <CardContent>
                  <EmptyState
                    icon={Briefcase}
                    title="No jobs yet"
                    description="Create your first job to start tracking who is working on what."
                    action={
                      <>
                        <Button leadingIcon={<Plus aria-hidden="true" />}>New job</Button>
                        <Button variant="ghost">Import CSV</Button>
                      </>
                    }
                  />
                </CardContent>
              </Card>
              <EmptyState bordered size="sm" title="No results" description="Try a different search or clear the filters." />
              <Card>
                <CardContent>
                  <ErrorState homeHref="/dashboard" digest="a1b2c3d4" />
                </CardContent>
              </Card>
            </div>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-5">
              <Row label="Progress">
                <div className="flex w-full max-w-md flex-col gap-3">
                  <Progress value={64} label="Completion" showLabel showValue />
                  <Progress value={25} auto size="md" label="Auto danger" showValue />
                  <Progress value={55} auto label="Auto warning" showValue />
                  <Progress value={90} auto label="Auto success" showValue />
                  <Progress value={40} tone="info" size="xs" label="Info xs" />
                </div>
              </Row>
              <Row label="Spinner">
                <Spinner size="xs" />
                <Spinner size="sm" />
                <Spinner size="md" />
                <Spinner size="lg" className="text-accent" />
              </Row>
              <Row label="Separator">
                <div className="flex w-full max-w-md flex-col gap-4">
                  <Separator />
                  <Separator label="Today" />
                  <div className="flex h-6 items-center gap-3 text-sm">
                    <span>Left</span>
                    <Separator orientation="vertical" />
                    <span>Right</span>
                  </div>
                </div>
              </Row>
              <Row label="Scroll area">
                <ScrollArea maxHeight={120} fade className="w-full max-w-md rounded-md border border-border bg-surface-sunken p-3 text-sm">
                  {Array.from({ length: 12 }, (_, i) => (
                    <div key={i} className="py-1 text-ink-secondary">
                      {`10:${String(10 + i).padStart(2, "0")} AM — Event ${i + 1}: status changed`}
                    </div>
                  ))}
                </ScrollArea>
              </Row>
            </CardContent>
          </Card>
        </Section>

        {/* ---------------------------------------------------------- */}
        <Section id="header" title="Page header" description="Breadcrumb eyebrow, title with inline meta, description, actions and a slot for tabs or filters.">
          <Card>
            <CardContent>
              <PageHeader
                eyebrow={[
                  { label: "Production", href: "/jobs" },
                  { label: "Jobs", href: "/jobs" },
                  { label: "PJ-0142" },
                ]}
                backHref="/jobs"
                backLabel="All jobs"
                title="123 Smith Street"
                meta={
                  <>
                    <StatusBadge status="in-progress" />
                    <PriorityBadge priority="high" size="sm" />
                  </>
                }
                description="Harcourts Newtown · Real estate · Shot 7 Oct, due 9 Oct 2026."
                actions={
                  <>
                    <Button variant="outline" leadingIcon={<Pencil aria-hidden="true" />}>
                      Edit
                    </Button>
                    <Button>Submit for review</Button>
                    <IconButton label="More" variant="outline">
                      <Ellipsis />
                    </IconButton>
                  </>
                }
              />
            </CardContent>
          </Card>
        </Section>
      </PageContainer>
    </AppShell>
  );
}
