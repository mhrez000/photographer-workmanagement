import "server-only";
import type { DbLike } from "@/db";
import type { AuthContext } from "@/lib/types";
import { NotFoundError, ValidationError } from "@/server/errors";
import { listJobs, type JobListResult } from "@/server/queries/jobs";

export interface SafeJobList {
  result: JobListResult;
  /** The input actually used (bad keys / a missing saved view dropped). */
  input: Record<string, string>;
  /** Explains anything that was ignored, for a quiet notice above the table. */
  notice: string | null;
}

/**
 * `listJobs` for pages: a shared link with a stale saved view or an invalid
 * filter value degrades to the closest valid list (with a notice) instead of
 * a 404 / error page. Permission errors still propagate.
 */
export function safeListJobs(db: DbLike, ctx: AuthContext, input: Record<string, string>): SafeJobList {
  let current = input;
  let staleView = false;
  let unknownBad = false;
  const ignored = new Set<string>();
  const noticeOf = (): string | null => {
    const parts: string[] = [];
    if (staleView) parts.push("That saved view is no longer available, so its filters were not applied.");
    if (ignored.size > 0) parts.push(`Ignored an invalid ${[...ignored].join(", ")} value in the link.`);
    if (unknownBad) parts.push("Some filters in the link were invalid and were ignored.");
    return parts.length ? parts.join(" ") : null;
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return { result: listJobs(db, ctx, current), input: current, notice: noticeOf() };
    } catch (err) {
      if (err instanceof NotFoundError && current.viewId) {
        const rest = { ...current };
        delete rest.viewId;
        current = rest;
        staleView = true;
        continue;
      }
      if (err instanceof ValidationError) {
        const bad = [...fieldsOf(err.details)].filter((k) => k in current);
        if (bad.length === 0) {
          // Unknown which field failed: fall back to an unfiltered list.
          current = {};
          unknownBad = true;
          continue;
        }
        const rest: Record<string, string> = {};
        for (const [k, v] of Object.entries(current)) if (!bad.includes(k)) rest[k] = v;
        bad.forEach((k) => ignored.add(k));
        current = rest;
        continue;
      }
      throw err;
    }
  }
  unknownBad = true;
  return { result: listJobs(db, ctx, {}), input: {}, notice: noticeOf() };
}

function fieldsOf(details: unknown): Set<string> {
  const out = new Set<string>();
  if (details && typeof details === "object") {
    const fe = (details as { fieldErrors?: Record<string, unknown> }).fieldErrors;
    if (fe && typeof fe === "object") for (const k of Object.keys(fe)) out.add(k.split(".")[0]);
  }
  return out;
}
