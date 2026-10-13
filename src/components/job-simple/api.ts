/**
 * Browser-side calls for the simplified job actions (docs/SIMPLIFICATION-PLAN.md §5).
 * One place for every path, so the dialogs here, Home and My jobs all hit the
 * same routes (`src/app/api/jobs/[id]/simple/*`, services in
 * `src/server/services/simple.ts`). Inputs are the Zod output types of
 * `src/lib/validation/simple.ts` minus `jobId` (the path carries it).
 */
import { markStalePage } from "@/components/jobs/mutation";
import { api } from "@/lib/api-client";
import type { ApproveShareChoice, SimpleReopenReason } from "@/lib/constants";
import type { EditorPickerOption } from "@/lib/types";

type Without<T, K extends keyof T> = Omit<T, K>;

export interface FinishedLinkByUrl {
  url: string;
  label?: string | null;
}
export type FinishedLinkInput = FinishedLinkByUrl | { reuseCurrent: true };

export interface SendForCheckingBody {
  expectedVersion: number;
  finishedLink: FinishedLinkInput;
  note?: string | null;
}

export interface ApproveBody {
  expectedVersion: number;
  share: ApproveShareChoice;
  confirmSelfApproval?: boolean;
  shareLinkIds?: string[];
}

export interface AskForChangesBody {
  expectedVersion: number;
  note: string;
  chips?: string[];
  neededBy?: string | null;
}

export interface ReopenBody {
  expectedVersion: number;
  reason: SimpleReopenReason;
  note?: string | null;
  newLink?: FinishedLinkByUrl;
}

export interface WithReason {
  expectedVersion: number;
  reason: string;
}
export interface OptionalReason {
  expectedVersion: number;
  reason?: string | null;
}
export interface EditorChoice {
  expectedVersion: number;
  editorId: string;
  reason?: string | null;
}

/** `/api/jobs/:id/simple/<action>` */
export function simpleJobPath(jobId: string, action: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/simple/${action}`;
}

/**
 * A simple action from a page that no longer matches the job — 409 (someone else changed it) or 403 (the
 * job moved on: "This job is now with Sam. Nothing to do here.") — is a STALE PAGE, never a dialog or a
 * blame: `useMutationRunner` / `useConflict` answer it with router.refresh() + one toast. Edits keep the
 * ConflictDialog (they never go through here).
 */
async function stalePage<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw markStalePage(err);
  }
}

const post = <T,>(path: string, body: unknown) => stalePage(api.post<T>(path, body));

/** Thin, typed wrappers. Every call returns the service result (`{ job, stage, … }`); callers `router.refresh()`. */
export const simpleJobApi = {
  assignEditor: (jobId: string, body: Without<EditorChoice, "reason">) => post<unknown>(simpleJobPath(jobId, "assign"), body),
  changeEditor: (jobId: string, body: EditorChoice) => post<unknown>(simpleJobPath(jobId, "change-editor"), body),
  takeBack: (jobId: string, body: OptionalReason) => post<unknown>(simpleJobPath(jobId, "take-back"), body),
  decline: (jobId: string, body: WithReason) => post<unknown>(simpleJobPath(jobId, "decline"), body),
  sendForChecking: (jobId: string, body: SendForCheckingBody) => post<unknown>(simpleJobPath(jobId, "send-for-checking"), body),
  approve: (jobId: string, body: ApproveBody) => post<unknown>(simpleJobPath(jobId, "approve"), body),
  askForChanges: (jobId: string, body: AskForChangesBody) => post<unknown>(simpleJobPath(jobId, "ask-for-changes"), body),
  reopen: (jobId: string, body: ReopenBody) => post<unknown>(simpleJobPath(jobId, "reopen"), body),
  cancel: (jobId: string, body: WithReason) => post<unknown>(simpleJobPath(jobId, "cancel"), body),
  restore: (jobId: string, body: OptionalReason) => post<unknown>(simpleJobPath(jobId, "restore"), body),
  /** "Start editing" (optional step): the engine route, no timer; a stale page gets 409 → refresh + toast before any actor check. */
  startEditing: (jobId: string, body: { expectedVersion: number }) => post<unknown>(`/api/jobs/${encodeURIComponent(jobId)}/start`, { ...body, startTimer: false }),
  /** "Send to client" on a Done job that was approved only (plan §4 "Not sent to client"). */
  sendToClient: (jobId: string, body: { expectedVersion: number; shareLinkIds?: string[] }) =>
    post<unknown>(`/api/jobs/${encodeURIComponent(jobId)}/transition`, {
      toCategory: "delivered",
      expectedVersion: body.expectedVersion,
      delivery: { shareJob: true, ...(body.shareLinkIds && body.shareLinkIds.length > 0 ? { shareLinkIds: body.shareLinkIds } : {}) },
    }),
  /** The Assign / Change editor picker rows ("On their desk 3 · Late 1", "4 of 6"). */
  editorOptions: (signal?: AbortSignal) => api.get<EditorPickerOption[]>("/api/editors/options", { signal }),
};
