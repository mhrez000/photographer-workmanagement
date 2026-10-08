"use client";

import * as React from "react";
import {
  Archive,
  Calendar,
  Copy,
  Download,
  Ellipsis,
  Filter,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Share2,
  SquareKanban,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Sheet, SheetBody, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { TBody, TD, TH, THead, TR, Table, type SortDirection } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { StatusBadge, PriorityBadge, type StatusCategory, type PriorityKey } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";

/* ------------------------------------------------------------------ */
/*  Dialog                                                             */
/* ------------------------------------------------------------------ */

export function DialogDemo() {
  const [open, setOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open form dialog
      </Button>
      <Button variant="danger" onClick={() => setConfirmOpen(true)}>
        Destructive confirm
      </Button>

      <Dialog open={open} onOpenChange={setOpen} size="md">
        <DialogHeader>
          <DialogTitle>Reassign editor</DialogTitle>
          <DialogDescription>
            The current editor will be notified and the change is recorded in the job history.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 py-4">
          <FormField label="Editor" required description="Only editors with capacity this week are listed.">
            <Select
              placeholder="Choose an editor"
              defaultValue=""
              options={[
                { value: "1", label: "Priya Nair — 3 jobs" },
                { value: "2", label: "Tom Becker — 5 jobs" },
                { value: "3", label: "Mei Lin — 8 jobs (near capacity)" },
              ]}
            />
          </FormField>
          <FormField label="Reason" optional>
            <Input placeholder="e.g. Tom is on leave from Thursday" />
          </FormField>
          <Checkbox label="Notify the photographer as well" defaultChecked />
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => {
              setOpen(false);
              toast.success("Editor reassigned", "Priya Nair now owns PJ-0142.");
            }}
          >
            Reassign
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen} size="sm">
        <DialogHeader hideClose>
          <DialogTitle>Cancel this job?</DialogTitle>
          <DialogDescription>
            PJ-0142 will move to Cancelled. Its history stays intact and it can be reopened later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>
            <Button variant="ghost">Keep job</Button>
          </DialogClose>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmOpen(false);
              toast({ title: "Job cancelled", description: "PJ-0142 moved to Cancelled.", variant: "warning" });
            }}
          >
            Cancel job
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sheet                                                              */
/* ------------------------------------------------------------------ */

export function SheetDemo() {
  const [side, setSide] = React.useState<"left" | "right" | "bottom" | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setSide("right")}>
        Right sheet
      </Button>
      <Button variant="outline" onClick={() => setSide("left")}>
        Left sheet
      </Button>
      <Button variant="outline" onClick={() => setSide("bottom")}>
        Bottom sheet
      </Button>

      <Sheet open={side !== null} onOpenChange={(open) => !open && setSide(null)} side={side ?? "right"} size="md">
        <SheetHeader>
          <SheetTitle>PJ-0142 · 123 Smith Street</SheetTitle>
          <SheetDescription>Real estate · Harcourts Newtown · Due tomorrow</SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="in-progress" />
            <PriorityBadge priority="high" />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-ink-muted">Photographer</dt>
            <dd className="flex items-center gap-2 text-ink">
              <Avatar name="Jordan Blake" size="xs" /> Jordan Blake
            </dd>
            <dt className="text-ink-muted">Editor</dt>
            <dd className="flex items-center gap-2 text-ink">
              <Avatar name="Priya Nair" size="xs" /> Priya Nair
            </dd>
            <dt className="text-ink-muted">Revisions</dt>
            <dd className="numeric text-ink">1</dd>
            <dt className="text-ink-muted">Completion</dt>
            <dd>
              <Progress value={64} showValue size="xs" />
            </dd>
          </dl>
          <p className="text-sm text-ink-secondary">
            Twilight exteriors need sky replacement; keep the warm interior grade from the last job for this agency.
          </p>
        </SheetBody>
        <SheetFooter>
          <Button variant="ghost" onClick={() => setSide(null)}>
            Close
          </Button>
          <Button>Open job</Button>
        </SheetFooter>
      </Sheet>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dropdown + Popover                                                 */
/* ------------------------------------------------------------------ */

export function DropdownDemo() {
  const [showArchived, setShowArchived] = React.useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger trailingIcon={<Ellipsis aria-hidden="true" />}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Job actions" className="w-56">
          <DropdownMenuLabel>Job</DropdownMenuLabel>
          <DropdownMenuItem icon={<Pencil />} shortcut="E" onSelect={() => toast.info("Edit job")}>
            Edit details
          </DropdownMenuItem>
          <DropdownMenuItem icon={<UserPlus />} onSelect={() => toast.info("Reassign")}>
            Reassign editor
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Copy />} shortcut="⌘D">
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Share2 />} href="/design-system#dropdown">
            Share link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem checked={showArchived} keepOpen onSelect={() => setShowArchived((v) => !v)}>
            Show archived
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Archive />} disabled>
            Archive (locked)
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Trash2 />} destructive onSelect={() => toast.error("Deleted", "Just kidding.")}>
            Delete job
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger variant="ghost" size="icon" aria-label="More">
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="More">
          <DropdownMenuItem icon={<Download />}>Export CSV</DropdownMenuItem>
          <DropdownMenuItem icon={<Calendar />}>Add to calendar</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger leadingIcon={<Filter aria-hidden="true" />}>Filters</PopoverTrigger>
        <PopoverContent aria-label="Filters" className="w-72">
          <div className="flex flex-col gap-4">
            <div className="text-sm font-semibold">Filter jobs</div>
            <FormField label="Status">
              <Select
                defaultValue="all"
                options={[
                  { value: "all", label: "Any status" },
                  { value: "in-progress", label: "In progress" },
                  { value: "review", label: "Review required" },
                ]}
                size="sm"
              />
            </FormField>
            <Checkbox label="Overdue only" size="sm" />
            <Checkbox label="Assigned to me" size="sm" defaultChecked />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost">
                Reset
              </Button>
              <Button size="sm">Apply</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Toast                                                              */
/* ------------------------------------------------------------------ */

export function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => toast({ title: "Saved", description: "Your changes are in." })}>
        Default
      </Button>
      <Button variant="outline" size="sm" onClick={() => toast.success("Job submitted for review", "Sarah will be notified.")}>
        Success
      </Button>
      <Button variant="outline" size="sm" onClick={() => toast.warning("Near capacity", "Mei has 8 jobs this week.")}>
        Warning
      </Button>
      <Button variant="outline" size="sm" onClick={() => toast.error("Couldn't save", "The server returned 500.")}>
        Danger
      </Button>
      <Button variant="outline" size="sm" onClick={() => toast.info("Tip", "Press ⌘K to search anything.")}>
        Info
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          toast({
            title: "Job archived",
            description: "PJ-0101 moved out of the active list.",
            duration: 8000,
            action: { label: "Undo", onClick: () => toast.success("Restored") },
          })
        }
      >
        With action
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tabs + Segmented                                                   */
/* ------------------------------------------------------------------ */

export function TabsDemo() {
  const [view, setView] = React.useState<"table" | "board" | "cards">("table");
  const [range, setRange] = React.useState<"today" | "week" | "month">("week");

  return (
    <div className="flex flex-col gap-8">
      <Tabs defaultValue="activity">
        <TabsList aria-label="Job sections">
          <TabsTrigger value="activity" count={12}>
            Activity
          </TabsTrigger>
          <TabsTrigger value="comments" count={3}>
            Comments
          </TabsTrigger>
          <TabsTrigger value="revisions" count={1}>
            Revisions
          </TabsTrigger>
          <TabsTrigger value="links">Links</TabsTrigger>
          <TabsTrigger value="history" disabled>
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="text-sm text-ink-secondary">
          10:42 AM — Jordan Blake changed status from <strong>Assigned</strong> → <strong>In Progress</strong>.
        </TabsContent>
        <TabsContent value="comments" className="text-sm text-ink-secondary">
          Three comments, one unresolved question from the editor.
        </TabsContent>
        <TabsContent value="revisions" className="text-sm text-ink-secondary">
          One revision requested: “Straighten verticals in hero shot.”
        </TabsContent>
        <TabsContent value="links" className="text-sm text-ink-secondary">
          Raw files (Dropbox) · Editing workspace (Lightroom) · Gallery (Pixieset).
        </TabsContent>
      </Tabs>

      <Tabs defaultValue="all" variant="pills">
        <TabsList aria-label="Filter">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="mine">Mine</TabsTrigger>
          <TabsTrigger value="overdue">Overdue</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-4">
        <SegmentedControl
          aria-label="View"
          value={view}
          onValueChange={setView}
          options={[
            { value: "table", label: "Table", icon: <List aria-hidden="true" /> },
            { value: "board", label: "Board", icon: <SquareKanban aria-hidden="true" /> },
            { value: "cards", label: "Cards", icon: <LayoutGrid aria-hidden="true" /> },
          ]}
        />
        <SegmentedControl
          aria-label="View (icons)"
          size="sm"
          value={view}
          onValueChange={setView}
          options={[
            { value: "table", label: "Table", icon: <List aria-hidden="true" />, iconOnly: true },
            { value: "board", label: "Board", icon: <SquareKanban aria-hidden="true" />, iconOnly: true },
            { value: "cards", label: "Cards", icon: <LayoutGrid aria-hidden="true" />, iconOnly: true },
          ]}
        />
        <SegmentedControl
          aria-label="Range"
          size="sm"
          value={range}
          onValueChange={setRange}
          options={[
            { value: "today", label: "Today" },
            { value: "week", label: "This week" },
            { value: "month", label: "This month" },
          ]}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sortable table                                                     */
/* ------------------------------------------------------------------ */

interface Row {
  id: string;
  job: string;
  client: string;
  photographer: string;
  editor: string;
  status: StatusCategory;
  priority: PriorityKey;
  due: string;
  daysLeft: number;
  revisions: number;
  completion: number;
}

const ROWS: Row[] = [
  { id: "PJ-0142", job: "123 Smith Street", client: "Harcourts Newtown", photographer: "Jordan Blake", editor: "Priya Nair", status: "in-progress", priority: "high", due: "9 Oct 2026", daysLeft: 1, revisions: 1, completion: 64 },
  { id: "PJ-0141", job: "45 Collins Street", client: "Ray White CBD", photographer: "Sam Ortiz", editor: "Tom Becker", status: "review", priority: "urgent", due: "8 Oct 2026", daysLeft: 0, revisions: 0, completion: 90 },
  { id: "PJ-0139", job: "Bayside Apartments — Stage 2", client: "Meriton", photographer: "Jordan Blake", editor: "Mei Lin", status: "revision", priority: "normal", due: "6 Oct 2026", daysLeft: -2, revisions: 2, completion: 75 },
  { id: "PJ-0138", job: "Nguyen family portraits", client: "Private", photographer: "Ava Chen", editor: "Priya Nair", status: "submitted", priority: "low", due: "14 Oct 2026", daysLeft: 6, revisions: 0, completion: 100 },
  { id: "PJ-0135", job: "Riverside Café menu shoot", client: "Riverside Hospitality", photographer: "Sam Ortiz", editor: "Tom Becker", status: "approved", priority: "normal", due: "3 Oct 2026", daysLeft: -5, revisions: 1, completion: 100 },
  { id: "PJ-0131", job: "88 George Street", client: "Belle Property", photographer: "Ava Chen", editor: "Mei Lin", status: "completed", priority: "normal", due: "1 Oct 2026", daysLeft: -7, revisions: 0, completion: 100 },
];

type SortKey = keyof Pick<Row, "job" | "client" | "due" | "daysLeft" | "revisions" | "completion">;

export function SortableTableDemo() {
  const [sortKey, setSortKey] = React.useState<SortKey>("daysLeft");
  const [direction, setDirection] = React.useState<SortDirection>("asc");
  const [selected, setSelected] = React.useState<Set<string>>(new Set(["PJ-0141"]));

  const rows = React.useMemo(() => {
    const sorted = [...ROWS].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return direction === "desc" ? -cmp : cmp;
    });
    return sorted;
  }, [sortKey, direction]);

  const sortBy = (key: SortKey) => () => {
    if (key === sortKey) setDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDirection("asc");
    }
  };

  const allSelected = selected.size === ROWS.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ROWS.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sortProps = (key: SortKey) => ({
    sortable: true,
    sortDirection: sortKey === key ? direction : null,
    onSort: sortBy(key),
  });

  return (
    <Table bordered maxHeight={360}>
      <THead>
        <TR>
          <TH shrink>
            <Checkbox
              aria-label="Select all"
              size="sm"
              checked={allSelected}
              indeterminate={someSelected}
              onChange={toggleAll}
            />
          </TH>
          <TH {...sortProps("job")}>Job</TH>
          <TH {...sortProps("client")}>Client</TH>
          <TH>Photographer</TH>
          <TH>Editor</TH>
          <TH>Status</TH>
          <TH>Priority</TH>
          <TH {...sortProps("due")}>Due</TH>
          <TH numeric {...sortProps("daysLeft")}>
            Days left
          </TH>
          <TH numeric {...sortProps("revisions")}>
            Rev.
          </TH>
          <TH {...sortProps("completion")}>Completion</TH>
          <TH shrink>
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.id} selected={selected.has(row.id)} interactive>
            <TD>
              <Checkbox
                aria-label={`Select ${row.id}`}
                size="sm"
                checked={selected.has(row.id)}
                onChange={() => toggleOne(row.id)}
              />
            </TD>
            <TD primary>
              <div className="flex flex-col">
                <span>{row.job}</span>
                <span className="font-mono text-2xs font-normal text-ink-subtle">{row.id}</span>
              </div>
            </TD>
            <TD muted>{row.client}</TD>
            <TD>
              <span className="flex items-center gap-2">
                <Avatar name={row.photographer} size="xs" />
                {row.photographer}
              </span>
            </TD>
            <TD>
              <span className="flex items-center gap-2">
                <Avatar name={row.editor} size="xs" />
                {row.editor}
              </span>
            </TD>
            <TD>
              <StatusBadge status={row.status} size="sm" />
            </TD>
            <TD>
              <PriorityBadge priority={row.priority} size="sm" />
            </TD>
            <TD muted>{row.due}</TD>
            <TD numeric className={row.daysLeft < 0 ? "font-medium text-danger" : row.daysLeft === 0 ? "font-medium text-attention" : undefined}>
              {row.daysLeft < 0 ? `${Math.abs(row.daysLeft)}d overdue` : row.daysLeft === 0 ? "Today" : `${row.daysLeft}d`}
            </TD>
            <TD numeric>{row.revisions}</TD>
            <TD>
              <Progress value={row.completion} size="xs" auto className="w-24" label={`${row.completion}% complete`} />
            </TD>
            <TD>
              <IconButton label="Row actions" size="xs">
                <Ellipsis />
              </IconButton>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/* ------------------------------------------------------------------ */
/*  Forms (interactive bits)                                           */
/* ------------------------------------------------------------------ */

export function SwitchDemo() {
  const [notify, setNotify] = React.useState(true);
  return (
    <div className="flex flex-col gap-4">
      <Switch
        checked={notify}
        onCheckedChange={setNotify}
        label="Email me when a job is submitted for review"
        description="Sent immediately, in your organisation's timezone."
      />
      <Switch size="sm" defaultChecked label="Compact tables" />
      <Switch disabled label="Two-factor authentication (managed by your admin)" />
      <div className="flex items-center gap-3">
        <Switch aria-label="Standalone" />
        <Switch aria-label="Standalone small" size="sm" defaultChecked />
      </div>
    </div>
  );
}

export function SearchDemo() {
  const [value, setValue] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  return (
    <div className="flex max-w-md flex-col gap-2">
      <SearchInput value={value} onValueChange={setValue} onDebouncedChange={setDebounced} shortcut="/" />
      <p className="text-xs text-ink-muted">
        Debounced value: <span className="font-mono text-ink">{debounced || "—"}</span>
      </p>
    </div>
  );
}

export function LoadingButtonDemo() {
  const [loading, setLoading] = React.useState(false);
  return (
    <Button
      loading={loading}
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => {
        setLoading(true);
        window.setTimeout(() => {
          setLoading(false);
          toast.success("Job created", "PJ-0143 is ready for assignment.");
        }, 1400);
      }}
    >
      {loading ? "Creating…" : "Create job"}
    </Button>
  );
}

export function CheckboxDemo() {
  const [items, setItems] = React.useState([true, false, true]);
  const all = items.every(Boolean);
  const some = items.some(Boolean) && !all;
  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        label="Select all jobs"
        checked={all}
        indeterminate={some}
        onChange={() => setItems(items.map(() => !all))}
      />
      <div className="ml-6 flex flex-col gap-2">
        {["123 Smith Street", "45 Collins Street", "88 George Street"].map((label, i) => (
          <Checkbox
            key={label}
            size="sm"
            label={label}
            checked={items[i]}
            onChange={() => setItems(items.map((v, j) => (i === j ? !v : v)))}
          />
        ))}
      </div>
      <Checkbox label="Disabled" disabled />
      <Checkbox label="Disabled, checked" disabled defaultChecked />
      <Checkbox label="Invalid" invalid description="You must accept the terms to continue." />
      <div className="flex items-center gap-2">
        <Label htmlFor="bare-check">Bare checkbox with external label</Label>
        <Checkbox id="bare-check" />
      </div>
    </div>
  );
}
