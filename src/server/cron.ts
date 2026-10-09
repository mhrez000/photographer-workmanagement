import { timingSafeEqual } from "node:crypto";
import type { Db } from "@/db/index";
import { organisations } from "@/db/schema";
import { runSweep, type SweepResult } from "@/server/services/sweep";

/**
 * Scheduler entry point (ARCHITECTURE.md §8 "Sweep"). An external scheduler
 * (cron, Vercel Cron, GitHub Actions…) calls `/api/system/cron/sweep` with
 * `Authorization: Bearer $CRON_SECRET` so overdue notifications and workload
 * alerts fire even when nobody opens the app. Disabled when CRON_SECRET is
 * unset or shorter than 32 characters.
 */

export const CRON_SECRET_MIN_LENGTH = 32;

/** The configured secret, or null when the scheduler endpoint is disabled. */
export function cronSecret(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.CRON_SECRET?.trim();
  return value && value.length >= CRON_SECRET_MIN_LENGTH ? value : null;
}

/** Constant-time check of an `Authorization: Bearer <secret>` header. */
export function isAuthorisedCronRequest(authorization: string | null, secret: string | null): boolean {
  if (!secret || !authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface CronSweepSummary {
  organisations: number;
  results: Pick<SweepResult, "organisationId" | "ranAt" | "overdueJobIds" | "reviewOverdueJobIds" | "timedOutSessionIds" | "errors">[];
}

/** Runs the sweep for every organisation. One org's failure never stops the others. */
export function sweepAllOrganisations(db: Db): CronSweepSummary {
  const orgIds = db.select({ id: organisations.id }).from(organisations).all();
  const results = orgIds.map(({ id }) => {
    try {
      const r = runSweep(db, id, { requestId: `cron-${Date.now().toString(36)}` });
      return {
        organisationId: r.organisationId,
        ranAt: r.ranAt,
        overdueJobIds: r.overdueJobIds,
        reviewOverdueJobIds: r.reviewOverdueJobIds,
        timedOutSessionIds: r.timedOutSessionIds,
        errors: r.errors,
      };
    } catch (err) {
      return {
        organisationId: id,
        ranAt: new Date().toISOString(),
        overdueJobIds: [],
        reviewOverdueJobIds: [],
        timedOutSessionIds: [],
        errors: [{ step: "replay" as const, message: err instanceof Error ? err.message : String(err) }],
      };
    }
  });
  return { organisations: orgIds.length, results };
}
