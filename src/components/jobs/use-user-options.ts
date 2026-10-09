"use client";

import * as React from "react";
import { api } from "@/lib/api-client";
import { WORKLOAD_BANDS, type Role, type WorkloadBand } from "@/lib/constants";
import type { UserRef } from "@/lib/types";

/**
 * Picker options from `GET /api/users/options?role=&jobId=` — active users
 * of a role, with their workload when the actor may see it. The normaliser is
 * tolerant of the exact payload shape (array, `{ items }`, nested `workload`).
 */

export interface UserOption extends UserRef {
  band: WorkloadBand | null;
  ratio: number | null;
  /** Active (open, editor-held) jobs. */
  activeJobs: number | null;
  /** Already holds / held this job (when `jobId` was passed). */
  isCurrent: boolean;
}

type Raw = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bandOf(v: unknown): WorkloadBand | null {
  return typeof v === "string" && (WORKLOAD_BANDS as readonly string[]).includes(v) ? (v as WorkloadBand) : null;
}

/** Normalises one option row from whatever the route returns. */
export function normaliseUserOption(raw: Raw): UserOption | null {
  const user = (raw.user && typeof raw.user === "object" ? raw.user : raw) as Raw;
  const id = typeof user.id === "string" ? user.id : null;
  const name = typeof user.name === "string" ? user.name : null;
  if (!id || !name) return null;
  const workload = (raw.workload && typeof raw.workload === "object" ? raw.workload : raw) as Raw;
  return {
    id,
    name,
    role: (typeof user.role === "string" ? user.role : "editor") as Role,
    avatarColour: typeof user.avatarColour === "string" ? user.avatarColour : "",
    isActive: user.isActive !== false,
    band: bandOf(workload.band),
    ratio: num(workload.ratio),
    activeJobs: num(workload.active) ?? num(workload.activeJobs) ?? num(workload.activeCount) ?? num(raw.activeJobs) ?? num(raw.active),
    isCurrent: raw.isCurrent === true || raw.current === true,
  };
}

function rowsOf(payload: unknown): Raw[] {
  if (Array.isArray(payload)) return payload as Raw[];
  if (payload && typeof payload === "object") {
    const p = payload as Raw;
    for (const key of ["items", "users", "options", "rows"]) if (Array.isArray(p[key])) return p[key] as Raw[];
  }
  return [];
}

export interface UseUserOptionsResult {
  options: UserOption[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Loads picker options once `enabled` (e.g. when a dialog opens). */
export function useUserOptions(role: Role | "editor" | "photographer", opts: { jobId?: string; enabled?: boolean } = {}): UseUserOptionsResult {
  const { jobId, enabled = true } = opts;
  const [state, setState] = React.useState<{ key: string; options: UserOption[]; error: string | null } | null>(null);
  const [nonce, setNonce] = React.useState(0);
  const key = `${role}|${jobId ?? ""}|${nonce}`;

  React.useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    api
      .get<unknown>("/api/users/options", { query: { role, jobId }, signal: controller.signal })
      .then((payload) => {
        const options = rowsOf(payload)
          .map(normaliseUserOption)
          .filter((o): o is UserOption => o !== null && o.isActive);
        setState({ key, options, error: null });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ key, options: [], error: err instanceof Error ? err.message : "Could not load people" });
      });
    return () => controller.abort();
  }, [enabled, key, role, jobId]);

  const current = state?.key === key ? state : null;
  return {
    options: current?.options ?? [],
    loading: enabled && current === null,
    error: current?.error ?? null,
    reload: () => setNonce((n) => n + 1),
  };
}
