"use client";

import * as React from "react";
import { api, type ApiError } from "@/lib/api-client";
import type { StatusCategory } from "@/lib/constants";
import type { DeliverContext } from "@/lib/sharing";
import type { StatusRef, UserRef } from "@/lib/types";
import { AssignEditorDialog } from "./assign-editor-dialog";
import { ConflictDialog } from "./conflict-dialog";
import { DeliverDialog, type DeliveryChoice } from "./deliver-dialog";
import { toDialogResult, useMutationRunner, type DialogSubmitResult } from "./mutation";
import { ReasonDialog } from "./reason-dialog";
import { RevisionRequestDialog } from "./revision-request-dialog";
import { StatusPickerDialog, TransitionOverrideDialog, type StatusCandidate } from "./status-picker-dialog";

/**
 * Shared state machine behind JobActionBar and JobQuickActions: runs a
 * workflow move against the REST API and handles every follow-up —
 * ambiguous target (status picker), editor required (assign dialog), reason
 * required (reason dialog), revision payload (revision dialog), 409 conflict
 * (conflict dialog) — then refreshes the page.
 */

/** The job facts the action UI needs. */
export interface ActionJobSummary {
  statusCategory: StatusCategory;
  isPaused: boolean;
  editor: UserRef | null;
  photographer: UserRef | null;
  /** Current status id (enables the override picker to exclude it). */
  statusId?: string;
  jobNumber?: string;
  name?: string;
}

/** One workflow move (from JobAvailableActions.transitions, or a guessed category move). */
export interface JobMove {
  toStatus?: StatusRef;
  toStatusId?: string;
  toCategory?: StatusCategory;
  label: string;
  isReopen: boolean;
  requiresRevisionPayload: boolean;
  requiresReason: boolean;
}

export interface TransitionExtra {
  reason?: string;
  override?: boolean;
  /** Deliver dialog payload (ROLES.md §7.3); only on a delivering move. */
  delivery?: DeliveryChoice;
}

type DialogState =
  | { kind: "none" }
  | { kind: "reason"; move: JobMove }
  | { kind: "revision"; move: JobMove }
  | { kind: "deliver"; move: JobMove }
  | { kind: "assign"; notice?: string }
  | { kind: "picker"; move: JobMove; extra: TransitionExtra; candidates: StatusCandidate[] }
  | { kind: "override" }
  | { kind: "conflict"; error: ApiError };

export interface JobActionControllerInput {
  jobId: string;
  version: number;
  job: ActionJobSummary;
  timeTrackingEnabled: boolean;
  /** The actor may run a timer on this job (JobAvailableActions.canUseTimer). */
  canUseTimer?: boolean;
  /** The actor may assign editors (JobAvailableActions.canAssignEditor). */
  canAssignEditor?: boolean;
  timeZone?: string;
  /** Statuses for the override picker. */
  workflowStatuses?: StatusRef[];
  /**
   * Client sharing facts for the Deliver dialog (ROLES.md §7.3). When set, a move into
   * Delivered opens the dialog; without it (no portal for this client, or the viewer
   * cannot share) the move runs directly and the server applies the default link set.
   */
  deliver?: DeliverContext | null;
}

export function moveKey(move: JobMove): string {
  return move.toStatusId ?? move.toStatus?.id ?? `cat:${move.toCategory ?? "?"}`;
}

export function moveTargetCategory(move: JobMove): StatusCategory | undefined {
  return move.toStatus?.category ?? move.toCategory;
}

function candidatesFrom(err: ApiError): StatusCandidate[] {
  const details = err.details as { candidates?: unknown } | undefined;
  if (!details || !Array.isArray(details.candidates)) return [];
  return details.candidates
    .map((c): StatusCandidate | null => {
      if (!c || typeof c !== "object") return null;
      const r = c as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.name !== "string") return null;
      return {
        id: r.id,
        name: r.name,
        key: typeof r.key === "string" ? r.key : undefined,
        category: typeof r.category === "string" ? (r.category as StatusCategory) : undefined,
        colour: typeof r.colour === "string" ? r.colour : null,
      };
    })
    .filter((c): c is StatusCandidate => c !== null);
}

function successText(move: JobMove, restoring: boolean): string {
  if (restoring) return "Job restored";
  if (moveTargetCategory(move) === "cancelled") return "Job cancelled";
  if (move.isReopen) return "Job reopened";
  if (move.toStatus) return `Moved to ${move.toStatus.name}`;
  return `${move.label} — done`;
}

/** Hook: action runners + the dialogs element to render once. */
export function useJobActionController(input: JobActionControllerInput) {
  const { jobId, version, job, timeTrackingEnabled, canUseTimer = false, canAssignEditor = false, timeZone, workflowStatuses, deliver = null } = input;
  const run = useMutationRunner();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>({ kind: "none" });

  /** Close a dialog only if it is still the one showing (a conflict may have replaced it). */
  const closeIf = React.useCallback((kind: DialogState["kind"]) => {
    setDialog((d) => (d.kind === kind ? { kind: "none" } : d));
  }, []);

  const onConflict = React.useCallback((error: ApiError) => setDialog({ kind: "conflict", error }), []);

  const jobLabel = job.jobNumber ? `${job.jobNumber}${job.name ? ` · ${job.name}` : ""}` : job.name;

  const transition = async (move: JobMove, extra: TransitionExtra = {}): Promise<DialogSubmitResult> => {
    const key = moveKey(move);
    const restoring = job.statusCategory === "cancelled" && !extra.override;
    const target = moveTargetCategory(move);
    const startTimer = timeTrackingEnabled && canUseTimer && target === "in_progress" ? true : undefined;
    setBusy(key);
    const result = await run(
      () =>
        restoring
          ? api.post(`/api/jobs/${jobId}/restore`, { jobId, expectedVersion: version, reason: extra.reason || null })
          : api.post(`/api/jobs/${jobId}/transition`, {
              jobId,
              expectedVersion: version,
              ...(move.toStatusId ?? move.toStatus?.id
                ? { toStatusId: move.toStatusId ?? move.toStatus?.id }
                : { toCategory: move.toCategory }),
              reason: extra.reason || undefined,
              override: extra.override || undefined,
              delivery: extra.delivery,
              startTimer,
            }),
      {
        success: successText(move, restoring),
        onConflict,
        onError: (err) => {
          if (err.code === "ambiguous_target") {
            const candidates = candidatesFrom(err);
            if (candidates.length > 0) {
              setDialog({ kind: "picker", move, extra, candidates });
              return true;
            }
          }
          if (err.code === "editor_required" && canAssignEditor) {
            setDialog({ kind: "assign", notice: `${err.message}. Once an editor is assigned, try “${move.label}” again.` });
            return true;
          }
          return false;
        },
      },
    );
    setBusy(null);
    return toDialogResult(result);
  };

  /** Entry point for a button press: opens the right dialog or moves straight away. */
  const startMove = (move: JobMove) => {
    if (move.requiresRevisionPayload) setDialog({ kind: "revision", move });
    else if (deliver && moveTargetCategory(move) === "delivered" && !move.isReopen) setDialog({ kind: "deliver", move });
    else if (move.requiresReason) setDialog({ kind: "reason", move });
    else void transition(move);
  };

  const pauseOrResume = async (which: "pause" | "resume") => {
    setBusy(which);
    await run(() => api.post(`/api/jobs/${jobId}/${which}`, { jobId, expectedVersion: version }), {
      success: which === "pause" ? "Job paused" : "Job resumed",
      onConflict,
    });
    setBusy(null);
  };

  const openAssign = (notice?: string) => setDialog({ kind: "assign", notice });
  const openOverride = () => setDialog({ kind: "override" });

  /** The header's "Deliver…" button: the first move into Delivered, through the dialog. */
  const openDeliver = (move: JobMove) => setDialog({ kind: "deliver", move });

  const reasonMove = dialog.kind === "reason" ? dialog.move : null;
  const deliverMove = dialog.kind === "deliver" ? dialog.move : null;
  const revisionMove = dialog.kind === "revision" ? dialog.move : null;
  const cancelling = reasonMove ? moveTargetCategory(reasonMove) === "cancelled" : false;

  const dialogs = (
    <>
      <ReasonDialog
        open={dialog.kind === "reason"}
        onOpenChange={(open) => (open ? undefined : closeIf("reason"))}
        title={cancelling ? "Cancel this job?" : (reasonMove?.label ?? "Reason")}
        description={
          cancelling
            ? "The job leaves every queue and workload, but its full history is kept and it can be restored later."
            : reasonMove?.isReopen
              ? "Reopening clears the completion date; the earlier completion stays in the history."
              : undefined
        }
        confirmLabel={cancelling ? "Cancel job" : (reasonMove?.label ?? "Confirm")}
        destructive={cancelling}
        suggestions={cancelling ? ["Client cancelled", "Duplicate job", "Shoot rescheduled", "Created by mistake"] : undefined}
        onSubmit={(reason) => (reasonMove ? transition(reasonMove, { reason }) : false)}
      />
      <RevisionRequestDialog
        open={dialog.kind === "revision"}
        onOpenChange={(open) => (open ? undefined : closeIf("revision"))}
        jobId={jobId}
        version={version}
        jobLabel={jobLabel}
        currentEditor={job.editor}
        toStatusId={revisionMove?.toStatusId ?? revisionMove?.toStatus?.id}
        isReopen={revisionMove?.isReopen ?? false}
        timeZone={timeZone}
        onConflict={onConflict}
      />
      {deliver ? (
        <DeliverDialog
          open={dialog.kind === "deliver"}
          onOpenChange={(open) => (open ? undefined : closeIf("deliver"))}
          jobLabel={job.jobNumber}
          context={deliver}
          onSubmit={(delivery) => (deliverMove ? transition(deliverMove, { delivery }) : false)}
        />
      ) : null}
      <AssignEditorDialog
        open={dialog.kind === "assign"}
        onOpenChange={(open) => (open ? undefined : closeIf("assign"))}
        jobId={jobId}
        version={version}
        current={job.editor}
        jobLabel={jobLabel}
        notice={dialog.kind === "assign" ? dialog.notice : undefined}
        onConflict={onConflict}
      />
      <StatusPickerDialog
        open={dialog.kind === "picker"}
        onOpenChange={(open) => (open ? undefined : closeIf("picker"))}
        candidates={dialog.kind === "picker" ? dialog.candidates : []}
        onPick={(statusId) =>
          dialog.kind === "picker"
            ? transition({ ...dialog.move, toStatusId: statusId, toStatus: undefined, toCategory: undefined }, dialog.extra)
            : false
        }
      />
      {workflowStatuses ? (
        <TransitionOverrideDialog
          open={dialog.kind === "override"}
          onOpenChange={(open) => (open ? undefined : closeIf("override"))}
          currentStatusId={job.statusId}
          statuses={workflowStatuses.map((s) => ({ id: s.id, name: s.name, key: s.key, category: s.category, colour: s.colour }))}
          onSubmit={({ statusId, reason }) => {
            const status = workflowStatuses.find((s) => s.id === statusId);
            return transition(
              { toStatusId: statusId, toStatus: status, label: "Override", isReopen: false, requiresReason: true, requiresRevisionPayload: false },
              { reason, override: true },
            );
          }}
        />
      ) : null}
      <ConflictDialog
        open={dialog.kind === "conflict"}
        onOpenChange={(open) => (open ? undefined : closeIf("conflict"))}
        error={dialog.kind === "conflict" ? dialog.error : null}
        timeZone={timeZone}
      />
    </>
  );

  return { busy, startMove, transition, pauseOrResume, openAssign, openOverride, openDeliver, onConflict, dialogs };
}

export type JobActionController = ReturnType<typeof useJobActionController>;
