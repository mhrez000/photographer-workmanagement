import type Database from "better-sqlite3";
import { getDb, sqlite, type Db } from "@/db/index";
import { verifyDerived } from "@/db/verify";
import { assertCan } from "@/server/auth/permissions";
import { requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";

/**
 * GET /api/system/integrity — owner-only `db:verify` report for the caller's
 * organisation (`IntegrityReport`: derived-column drift + structural checks).
 * Read-only; repairs go through POST /api/jobs/:id/recompute.
 */
export const GET = handle(async () => {
  const ctx = await requireContext();
  assertCan(ctx, "system.integrity");
  const db = getDb() as Db & { $client?: Database.Database };
  return verifyDerived(db.$client ?? sqlite, ctx.organisationId);
});
