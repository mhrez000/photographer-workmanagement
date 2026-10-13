import * as React from "react";
import { SectionCard } from "@/components/common";
import type { NoteKind } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { InstructionItem } from "@/lib/types";
import { InstructionComposer } from "./instruction-composer";

export interface InstructionsSectionProps {
  jobId: string;
  items: InstructionItem[];
  timeZone: string;
  /** The note kind the viewer may add with ("photographer" for owners / photographers, "editor" for editors), or null. */
  addAsKind: NoteKind | null;
  /** Link to the edit page when the viewer may change the description. */
  editHref: string | null;
  /** The viewer is the editor: the empty state and composer speak to them, not about them. */
  viewerIsEditor?: boolean;
  /** Who wrote the brief ("Mo") — for the editor's wording. */
  photographerName?: string | null;
  className?: string;
}

/**
 * Instructions for the editor (plan §5): one box. The description leads; the
 * photographer's and editor's notes follow, oldest first. The copy knows who is
 * reading: the owner is invited to brief the editor, the editor to add a note back.
 */
export function InstructionsSection({ jobId, items, timeZone, addAsKind, editHref, viewerIsEditor = false, photographerName = null, className }: InstructionsSectionProps) {
  const who = photographerName ?? "the photographer";
  const empty = viewerIsEditor ? `No instructions from ${who} yet.` : `No instructions yet.${addAsKind ? " Add anything the editor should know." : ""}`;
  return (
    <SectionCard
      id="instructions"
      title="Instructions for the editor"
      className={className}
      actions={
        editHref ? (
          <a href={editHref} className="text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline focus-ring rounded-xs">
            Edit
          </a>
        ) : null
      }
    >
      {items.length === 0 ? <p className="text-sm text-ink-muted">{empty}</p> : null}
      {items.length > 0 ? (
        <ol className="flex flex-col divide-y divide-border/70">
          {items.map((item, i) => (
            <li key={item.noteId ?? `desc-${i}`} className="py-3 first:pt-0 last:pb-0">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{item.body}</p>
              {item.source !== "description" ? (
                <p className="mt-1 text-xs text-ink-muted">
                  {item.author?.name ?? "Someone"}
                  {item.at ? (
                    <>
                      {" · "}
                      <time dateTime={item.at} title={formatDateTime(item.at, timeZone)}>
                        {formatDateShort(item.at, timeZone)}
                      </time>
                    </>
                  ) : null}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {addAsKind ? <InstructionComposer jobId={jobId} kind={addAsKind} forPhotographer={viewerIsEditor ? who : null} className={items.length > 0 ? "mt-4" : "mt-3"} /> : null}
    </SectionCard>
  );
}
