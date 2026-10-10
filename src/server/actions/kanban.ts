/**
 * `POST /api/kanban/drop` — a card dropped on a kanban column
 * (ARCHITECTURE.md §4.6 "Kanban drop mapping").
 *
 * Plain module (no "use server"): the REST handler runs it inside one
 * transaction. The column → status resolution is `previewKanbanDrop`
 * (lib `resolveKanbanDrop`); the move itself is `transitionJobStatus`, which
 * re-checks every permission, guard and the job version.
 *
 *   noop                → { kind: "noop" }
 *   none                → 422 invalid_transition (message = the explanation)
 *   ambiguous           → { kind: "ambiguous", candidates } unless `toStatusId` picks one
 *   → revision status   → { kind: "needs_revision_payload", move } unless `revision` is given
 *   reason required     → { kind: "needs_reason", move } unless `reason` is given
 *   otherwise           → { kind: "moved", job, fromStatus, toStatus, warnings }
 */
import { z } from "zod";
import type { Tx } from "@/db/index";
import { KANBAN_COLUMN_META, KANBAN_COLUMNS } from "@/lib/constants";
import type { AuthContext, KanbanDropResponse, KanbanMoveOption } from "@/lib/types";
import { ExpectedVersionSchema, IdSchema, RevisionInput } from "@/lib/validation/jobs";
import { toStatusRef, type AllowedMove } from "@/lib/workflow";
import { InvalidTransitionError } from "@/server/errors";
import { previewKanbanDrop } from "@/server/queries/kanban";
import { parseInput } from "@/server/services/_shared";
import { transitionJobStatus } from "@/server/services/workflow";

export const KanbanDropInput = z.object({
  jobId: IdSchema,
  column: z.enum(KANBAN_COLUMNS),
  /** The pick from an ambiguous drop. */
  toStatusId: IdSchema.optional(),
  expectedVersion: ExpectedVersionSchema,
  reason: z.string().trim().max(2000).nullish(),
  revision: RevisionInput.optional(),
  startTimer: z.boolean().optional(),
});

function toOption(m: AllowedMove): KanbanMoveOption {
  return {
    toStatus: toStatusRef(m.toStatus),
    label: m.label,
    isReopen: m.isReopen,
    requiresRevisionPayload: m.requiresRevisionPayload,
    requiresReason: m.requiresReason,
  };
}

export async function kanbanDrop(tx: Tx, ctx: AuthContext, input: unknown): Promise<KanbanDropResponse> {
  const p = parseInput(KanbanDropInput, input);
  const preview = await previewKanbanDrop(tx, ctx, p.jobId, p.column);
  const columnLabel = KANBAN_COLUMN_META[p.column].label;

  let move: AllowedMove;
  switch (preview.kind) {
    case "noop":
      return { kind: "noop" };
    case "none":
      throw new InvalidTransitionError("current status", columnLabel, preview.reason, { column: p.column });
    case "ambiguous": {
      if (!p.toStatusId) return { kind: "ambiguous", candidates: preview.candidates.map(toOption) };
      const picked = preview.candidates.find((c) => c.toStatus.id === p.toStatusId);
      if (!picked) {
        throw new InvalidTransitionError("current status", columnLabel, "That status is not one of the options for this column", {
          column: p.column,
          candidates: preview.candidates.map(toOption),
        });
      }
      move = picked;
      break;
    }
    case "single":
      move = preview.move;
      if (p.toStatusId && p.toStatusId !== move.toStatus.id) {
        throw new InvalidTransitionError("current status", columnLabel, "That status is not one of the options for this column", {
          column: p.column,
          candidates: [toOption(move)],
        });
      }
      break;
  }

  if (move.requiresRevisionPayload && !p.revision) return { kind: "needs_revision_payload", move: toOption(move) };
  if (move.requiresReason && !p.reason) return { kind: "needs_reason", move: toOption(move) };

  const result = await transitionJobStatus(tx, ctx, {
    jobId: p.jobId,
    toStatusId: move.toStatus.id,
    expectedVersion: p.expectedVersion,
    reason: p.reason ?? undefined,
    revision: p.revision,
    startTimer: p.startTimer,
  });
  return { kind: "moved", job: result.job, fromStatus: result.fromStatus, toStatus: result.toStatus, warnings: result.warnings };
}
