"use client";

import * as React from "react";
import { Dialog, DialogBody, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { formatHotkey } from "@/hooks/use-hotkeys";
import { KEYBOARD_SHORTCUTS } from "@/lib/constants";

const SCOPE_LABELS = { global: "Anywhere", list: "Lists & tables", job: "On a job" } as const;

/** Renders "g d" as G then D, "j / k" as J / K, "mod+k" as ⌘ K. */
function Keys({ spec }: { spec: string }) {
  if (spec.includes(" / ")) {
    const [a, b] = spec.split(" / ");
    return (
      <span className="inline-flex items-center gap-1">
        <Keys spec={a} />
        <span className="text-xs text-ink-subtle">/</span>
        <Keys spec={b} />
      </span>
    );
  }
  const sequence = spec.includes("+") ? [spec] : spec.split(" ");
  return (
    <span className="inline-flex items-center gap-1">
      {sequence.map((step, i) => (
        <React.Fragment key={`${step}-${i}`}>
          {i > 0 ? <span className="text-2xs text-ink-subtle">then</span> : null}
          {formatHotkey(step).map((k, j) => (
            <Kbd key={`${k}-${j}`} size="md">
              {k}
            </Kbd>
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The keyboard shortcut cheat sheet (opened with "?"), grouped by scope. */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const groups = (["global", "list", "job"] as const).map((scope) => ({
    scope,
    items: KEYBOARD_SHORTCUTS.filter((s) => s.scope === scope),
  }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Move faster without the mouse. Shortcuts pause while you are typing in a field.</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-6 pb-6 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.scope} className={g.scope === "global" ? "sm:row-span-2" : undefined}>
            <h3 className="eyebrow mb-2">{SCOPE_LABELS[g.scope]}</h3>
            <dl className="divide-y divide-border">
              {g.items.map((s) => (
                <div key={s.keys} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-sm text-ink-secondary">{s.description}</dt>
                  <dd className="shrink-0">
                    <Keys spec={s.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogBody>
    </Dialog>
  );
}
