/** Zod schemas for job notes (ARCHITECTURE.md §2.4, §9 Notes). */
import { z } from "zod";
import { NOTE_KINDS } from "@/lib/constants";

export const NOTE_BODY_MAX = 20_000;

const Id = z.string().trim().min(1).max(64);

export const NoteBodySchema = z
  .string({ error: "Write the note" })
  .trim()
  .min(1, "Write the note")
  .max(NOTE_BODY_MAX, `Keep notes under ${NOTE_BODY_MAX} characters`);

export const AddNoteInput = z
  .object({
    jobId: Id,
    kind: z.enum(NOTE_KINDS),
    body: NoteBodySchema,
    /** kind = revision only; defaults to the job's open revision. */
    revisionId: Id.nullish(),
    isPinned: z.boolean().default(false),
    /**
     * Honoured for the system context only (automation `add_note`): the user
     * recorded as author. Defaults to the job's creator.
     */
    authorUserId: Id.nullish(),
  })
  .refine((v) => !v.revisionId || v.kind === "revision", {
    path: ["revisionId"],
    message: "Only revision notes can reference a revision",
  });
export type AddNoteInput = z.input<typeof AddNoteInput>;

export const EditNoteInput = z
  .object({
    noteId: Id,
    expectedVersion: z.number().int().min(1),
    body: NoteBodySchema.optional(),
    isPinned: z.boolean().optional(),
  })
  .refine((v) => v.body !== undefined || v.isPinned !== undefined, { message: "Nothing to change" });
export type EditNoteInput = z.input<typeof EditNoteInput>;

export const ArchiveNoteInput = z.object({
  noteId: Id,
  expectedVersion: z.number().int().min(1).optional(),
});
export type ArchiveNoteInput = z.input<typeof ArchiveNoteInput>;

export const RestoreNoteInput = ArchiveNoteInput;
export type RestoreNoteInput = z.input<typeof RestoreNoteInput>;
