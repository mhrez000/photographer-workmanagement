"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { LinkProviderIcon } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LINK_KIND_META, LINK_KINDS, LINK_PROVIDER_LABELS, type LinkKind } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { deriveLinkProvider, isAllowedLinkUrl } from "@/lib/validation/links";

export interface DraftLink {
  key: string;
  kind: LinkKind;
  url: string;
  label: string;
}

let draftCounter = 0;
export function newDraftLink(kind: LinkKind = "raw_files"): DraftLink {
  draftCounter += 1;
  return { key: `link-${draftCounter}`, kind, url: "", label: "" };
}

/** Error for one draft row, or null. Empty rows are ignored (not an error). */
export function draftLinkError(link: DraftLink): string | null {
  const url = link.url.trim();
  if (!url) return null;
  if (!isAllowedLinkUrl(url)) return "Enter a full http:// or https:// link";
  return null;
}

/** Rows that will be sent (non-empty URL). */
export function filledLinks(links: DraftLink[]): DraftLink[] {
  return links.filter((l) => l.url.trim().length > 0);
}

export interface LinksEditorProps {
  links: DraftLink[];
  onChange: (links: DraftLink[]) => void;
  /** Kinds the actor may add (defaults to every kind). */
  kinds?: readonly LinkKind[];
  /** Server-side errors keyed by row key. */
  errors?: Record<string, string>;
  /** Show row errors only after the first submit attempt (or blur). */
  showErrors?: boolean;
  disabled?: boolean;
  /** Empty-state line (default mentions raw files; the New job form's "Other links" slot passes its own). */
  emptyText?: string;
}

/**
 * Initial external links (spec: media stays in external storage — raw files,
 * editing workspace, reference…). Each row: kind + URL (+ optional label);
 * the provider is detected from the host as you type.
 */
export function LinksEditor({
  links,
  onChange,
  kinds = LINK_KINDS,
  errors,
  showErrors = false,
  disabled,
  emptyText = "No links yet. Add where the raw files live, the editing workspace or reference material — files stay in your own storage.",
}: LinksEditorProps) {
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const update = (key: string, patch: Partial<DraftLink>) => onChange(links.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => onChange(links.filter((l) => l.key !== key));
  const add = () => {
    const used = new Set(links.map((l) => l.kind));
    const next = kinds.find((k) => !used.has(k)) ?? "other";
    onChange([...links, newDraftLink(next)]);
  };
  const kindOptions = kinds.map((k) => ({ value: k, label: LINK_KIND_META[k].label }));

  return (
    <div className="flex flex-col gap-3">
      {links.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-ink-muted">{emptyText}</p>
      ) : (
        <ul role="list" className="flex flex-col gap-3">
          {links.map((link, index) => {
            const url = link.url.trim();
            const provider = url && isAllowedLinkUrl(url) ? deriveLinkProvider(url) : null;
            const localError = showErrors || touched[link.key] ? draftLinkError(link) : null;
            const error = errors?.[link.key] ?? localError;
            const errorId = `${link.key}-error`;
            return (
              // Container query on the row so the URL always gets the widest track: narrow rows stack
              // kind / URL / label (URL full width); wide rows (≥ 56rem) are kind | URL | label | remove.
              // Visual order always matches DOM (tab) order.
              <li key={link.key} className="@container rounded-md border border-border bg-surface-sunken/50 p-3">
                <div
                  className={cn(
                    "grid items-start gap-2",
                    "grid-cols-[minmax(0,1fr)_auto] [grid-template-areas:'kind_remove'_'url_url'_'label_label']",
                    "@4xl:grid-cols-[11rem_minmax(0,1fr)_13rem_auto] @4xl:[grid-template-areas:'kind_url_label_remove']",
                  )}
                >
                  <div className="min-w-0 max-w-64 [grid-area:kind] @4xl:max-w-none">
                    <Select
                      aria-label={`Link ${index + 1} kind`}
                      value={link.kind}
                      onChange={(e) => update(link.key, { kind: e.target.value as LinkKind })}
                      options={kindOptions}
                      disabled={disabled}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5 [grid-area:url]">
                    <Input
                      type="url"
                      inputMode="url"
                      aria-label={`Link ${index + 1} URL`}
                      aria-describedby={error ? errorId : undefined}
                      invalid={Boolean(error)}
                      value={link.url}
                      placeholder="https://drive.google.com/…"
                      onChange={(e) => update(link.key, { url: e.target.value })}
                      onBlur={() => setTouched((t) => ({ ...t, [link.key]: true }))}
                      leading={<LinkProviderIcon provider={provider ?? "other"} url={url || null} />}
                      trailing={provider && provider !== "other" ? <span className="text-xs text-ink-muted">{LINK_PROVIDER_LABELS[provider]}</span> : undefined}
                      className={provider && provider !== "other" ? "pr-28" : undefined}
                      disabled={disabled}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {error ? (
                      <p id={errorId} role="alert" className="text-sm text-danger">
                        {error}
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 [grid-area:label]">
                    <Input
                      aria-label={`Link ${index + 1} label (optional)`}
                      value={link.label}
                      placeholder="Label (optional)"
                      onChange={(e) => update(link.key, { label: e.target.value })}
                      maxLength={200}
                      disabled={disabled}
                    />
                  </div>
                  <div className="[grid-area:remove]">
                    <IconButton label={`Remove link ${index + 1}`} variant="ghost" onClick={() => remove(link.key)} disabled={disabled}>
                      <X />
                    </IconButton>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button variant="outline" size="sm" leadingIcon={<Plus />} onClick={add} disabled={disabled}>
          Add link
        </Button>
      </div>
    </div>
  );
}
