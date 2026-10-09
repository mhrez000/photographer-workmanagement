/** Zod schemas for the job timer (ARCHITECTURE.md §2.4 work_sessions, §9 Time tracking). */
import { z } from "zod";

export const SESSION_NOTE_MAX = 1000;

const Id = z.string().trim().min(1).max(64);
const NoteSchema = z
  .string()
  .trim()
  .max(SESSION_NOTE_MAX)
  .transform((v) => (v.length === 0 ? null : v))
  .nullish();

export const StartTimerInput = z.object({
  jobId: Id,
  note: NoteSchema,
  /** Stop the actor's timer on another job first (otherwise 409 with the running session). */
  switchFromRunning: z.boolean().default(false),
});
export type StartTimerInput = z.input<typeof StartTimerInput>;

/**
 * Pause / stop: the actor's running timer (optionally pinned to `jobId`), or
 * a specific `sessionId` (owners/managers may stop someone else's timer).
 */
export const EndTimerInput = z.object({
  jobId: Id.optional(),
  sessionId: Id.optional(),
  note: NoteSchema,
});
export type EndTimerInput = z.input<typeof EndTimerInput>;

/** `POST /api/jobs/:id/timer { action, note? }`. */
export const TimerActionInput = z.object({
  jobId: Id,
  action: z.enum(["start", "pause", "stop"]),
  note: NoteSchema,
  switchFromRunning: z.boolean().default(false),
});
export type TimerActionInput = z.input<typeof TimerActionInput>;
