/**
 * `npm run db:verify` — derived-column drift report + structural invariants
 * (ARCHITECTURE.md §2.8). Pure read-only; never repairs. Used by the seed
 * (must be clean before exit), CI, `GET /api/system/integrity` and tests.
 *
 * Reads only the ledgers + jobs; no services, no permissions.
 *
 * An open (non-terminal) job held by an inactive editor is a structural
 * issue UNLESS that editor's latest `user.deactivated` event lists the job
 * with `action: "kept"` — the deliberate "deactivate without hand-over"
 * case behind the editor-unavailable bottleneck (the "flagged" exception
 * of §2.8; the demo seed's editor11 relies on it).
 *
 * The open revision's `assignee_user_id` must equal `jobs.editor_id` when
 * both are set (`open_revision_assignee_is_editor`).
 *
 * Postgres: each ledger is read ONCE (set-based, a fixed number of queries
 * whatever the job count — remote databases pay per round trip) inside one
 * REPEATABLE READ, READ ONLY transaction, i.e. one consistent snapshot.
 */
import { sql, type SQL } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { IntegrityReport } from "@/lib/types";
import { execRows, type DbLike, type Tx } from "./index";

interface JobRow extends Record<string, unknown> {
  id: string;
  status_id: string;
  status_category: string;
  previous_status_id: string | null;
  status_entered_at: string;
  photographer_id: string | null;
  editor_id: string | null;
  revision_count: number;
  open_revision_id: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  reopened_count: number;
  last_activity_at: string;
  client_id: string;
  project_client_id: string;
  workflow_id: string;
  status_workflow_id: string;
  status_actual_category: string;
}

interface TransitionRow extends Record<string, unknown> {
  id: string;
  job_id: string;
  sequence: number;
  kind: string;
  from_status_id: string | null;
  to_status_id: string;
  to_category: string;
  entered_at: string;
  exited_at: string | null;
  is_reopen: boolean;
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * Recompute every derived job column from the ledgers and compare. All reads
 * run in ONE read-only REPEATABLE READ transaction (a single snapshot): a job
 * written between two of the queries must not show up as drift on a busy server.
 * Pass a `Tx` to verify inside an existing transaction instead.
 */
export async function verifyDerived(db: DbLike, organisationId?: string): Promise<IntegrityReport> {
  if (db instanceof PgTransaction) return collectReport(db as Tx, organisationId);
  return db.transaction((tx) => collectReport(tx, organisationId), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function collectReport(tx: Tx, organisationId?: string): Promise<IntegrityReport> {
  const drift: IntegrityReport["drift"] = [];
  const structural: IntegrityReport["structural"] = [];
  /** `AND <alias>.organisation_id = $org` when scoped. */
  const org = (alias: string): SQL =>
    organisationId ? sql`AND ${sql.raw(alias)}.organisation_id = ${organisationId}` : sql``;

  // Sequential on purpose: one transaction = one connection.
  const jobs = await execRows<JobRow>(
    tx,
    sql`SELECT j.id, j.status_id, j.status_category, j.previous_status_id, j.status_entered_at,
               j.photographer_id, j.editor_id, j.revision_count, j.open_revision_id,
               j.completed_at, j.cancelled_at, j.reopened_count, j.last_activity_at,
               j.client_id, p.client_id AS project_client_id,
               j.workflow_id, s.workflow_id AS status_workflow_id, s.category AS status_actual_category
          FROM jobs j
          JOIN projects p ON p.id = j.project_id
          JOIN workflow_statuses s ON s.id = j.status_id
         WHERE TRUE ${org("j")}
         ORDER BY j.created_at, j.id`,
  );
  const transitions = await execRows<TransitionRow>(
    tx,
    sql`SELECT t.id, t.job_id, t.sequence, t.kind, t.from_status_id, t.to_status_id, t.to_category,
               t.entered_at, t.exited_at, t.is_reopen
          FROM job_status_transitions t
         WHERE TRUE ${org("t")}
         ORDER BY t.job_id, t.sequence`,
  );
  const openAssignments = await execRows<{ job_id: string; role: string; user_id: string }>(
    tx,
    sql`SELECT a.job_id, a.role, a.user_id FROM job_assignments a WHERE a.unassigned_at IS NULL ${org("a")} ORDER BY a.job_id, a.rowid`,
  );
  const revisions = await execRows<{ id: string; job_id: string; revision_number: number; resolved_at: string | null; assignee_user_id: string | null }>(
    tx,
    sql`SELECT r.id, r.job_id, r.revision_number, r.resolved_at, r.assignee_user_id
          FROM job_revisions r WHERE TRUE ${org("r")} ORDER BY r.job_id, r.revision_number`,
  );
  const lastEvents = await execRows<{ job_id: string; at: string }>(
    tx,
    sql`SELECT e.job_id, MAX(e.created_at) AS at FROM activity_events e WHERE e.job_id IS NOT NULL ${org("e")} GROUP BY e.job_id`,
  );
  const statusChanged = await execRows<{ job_id: string; transition_id: string }>(
    tx,
    sql`SELECT e.job_id, e.metadata->>'transitionId' AS transition_id
          FROM activity_events e
         WHERE e.event_type = 'job.status_changed' AND e.metadata ? 'transitionId' ${org("e")}`,
  );
  const revisionRequested = await execRows<{ revision_id: string }>(
    tx,
    sql`SELECT e.metadata->>'revisionId' AS revision_id
          FROM activity_events e
         WHERE e.event_type = 'revision.requested' AND e.metadata ? 'revisionId'`,
  );
  const openSessions = await execRows<{ job_id: string; n: number }>(
    tx,
    sql`SELECT w.job_id, COUNT(*) AS n FROM work_sessions w WHERE w.ended_at IS NULL ${org("w")} GROUP BY w.job_id`,
  );
  const inactiveUsers = await execRows<{ id: string }>(tx, sql`SELECT u.id FROM users u WHERE u.is_active = false ${org("u")}`);
  // "Flagged" = the editor's latest deactivation explicitly KEPT this job (neither reassign nor
  // unassign was chosen): the editor-unavailable bottleneck case, not an inconsistency (§2.8).
  const kept = await execRows<{ user_id: string; job_id: string }>(
    tx,
    sql`WITH latest AS (
          SELECT DISTINCT ON (e.entity_id) e.entity_id, e.metadata
            FROM activity_events e
           WHERE e.event_type = 'user.deactivated' ${org("e")}
           ORDER BY e.entity_id, e.rowid DESC
        )
        SELECT l.entity_id AS user_id, o.value->>'jobId' AS job_id
          FROM latest l
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(l.metadata->'openJobs') = 'array' THEN l.metadata->'openJobs' ELSE '[]'::jsonb END
          ) AS o(value)
         WHERE o.value->>'role' = 'editor' AND o.value->>'action' = 'kept'`,
  );

  const transitionsByJob = groupBy(transitions, (t) => t.job_id);
  const assignmentsByJob = groupBy(openAssignments, (a) => a.job_id);
  const revisionsByJob = groupBy(revisions, (r) => r.job_id);
  const lastEventByJob = new Map(lastEvents.map((e) => [e.job_id, e.at]));
  const statusChangedKeys = new Set(statusChanged.map((e) => `${e.job_id}|${e.transition_id}`));
  const requestedRevisionIds = new Set(revisionRequested.map((e) => e.revision_id));
  const openSessionsByJob = new Map(openSessions.map((s) => [s.job_id, Number(s.n)]));
  const inactive = new Set(inactiveUsers.map((u) => u.id));
  const keptKeys = new Set(kept.map((k) => `${k.user_id}|${k.job_id}`));

  const push = (jobId: string, column: string, stored: unknown, derived: unknown) => {
    if (stored !== derived) drift.push({ jobId, column, stored, derived });
  };

  for (const j of jobs) {
    // --- consistency that triggers also enforce (belt and braces) ---
    if (j.project_client_id !== j.client_id) structural.push({ check: "client_matches_project", jobId: j.id, detail: `jobs.client_id=${j.client_id} projects.client_id=${j.project_client_id}` });
    if (j.status_workflow_id !== j.workflow_id) structural.push({ check: "status_in_workflow", jobId: j.id, detail: `status workflow ${j.status_workflow_id} != job workflow ${j.workflow_id}` });
    push(j.id, "status_category", j.status_category, j.status_actual_category);

    const seq = transitionsByJob.get(j.id) ?? [];

    // --- open transition ---
    const open = seq.filter((t) => t.exited_at === null);
    if (open.length !== 1) {
      structural.push({ check: "one_open_transition", jobId: j.id, detail: `${open.length} open rows` });
    } else {
      const t = open[0];
      push(j.id, "status_id", j.status_id, t.to_status_id);
      push(j.id, "previous_status_id", j.previous_status_id, t.from_status_id ?? null);
      push(j.id, "status_entered_at", j.status_entered_at, t.entered_at);
      push(j.id, "completed_at", j.completed_at, t.to_category === "completed" ? t.entered_at : null);
      push(j.id, "cancelled_at", j.cancelled_at, t.to_category === "cancelled" ? t.entered_at : null);
      if (t.to_category === "completed" || t.to_category === "cancelled") {
        const n = openSessionsByJob.get(j.id) ?? 0;
        if (n > 0) structural.push({ check: "no_open_session_on_terminal", jobId: j.id, detail: `${n} running sessions` });
      }
    }

    // --- sequence contiguity, monotonic times, event linkage ---
    let prevExit: string | null = null;
    seq.forEach((t, i) => {
      if (t.sequence !== i + 1) structural.push({ check: "sequence_contiguous", jobId: j.id, detail: `expected ${i + 1} got ${t.sequence}` });
      if (prevExit && t.entered_at < prevExit) structural.push({ check: "entered_after_previous_exit", jobId: j.id, detail: `seq ${t.sequence}` });
      if (i < seq.length - 1 && t.exited_at == null) structural.push({ check: "only_last_open", jobId: j.id, detail: `seq ${t.sequence} open but not last` });
      prevExit = t.exited_at ?? prevExit;
      if (t.kind === "transition" && !statusChangedKeys.has(`${j.id}|${t.id}`)) {
        structural.push({ check: "transition_has_event", jobId: j.id, detail: `transition ${t.id} has no job.status_changed event` });
      }
    });
    if (seq.length === 0) structural.push({ check: "has_creation_transition", jobId: j.id, detail: "no transition rows" });

    // --- people ---
    const assignments = assignmentsByJob.get(j.id) ?? [];
    const ph = assignments.filter((a) => a.role === "photographer");
    const ed = assignments.filter((a) => a.role === "editor");
    if (ph.length > 1 || ed.length > 1) structural.push({ check: "one_open_assignment_per_role", jobId: j.id, detail: `photographer=${ph.length} editor=${ed.length}` });
    push(j.id, "photographer_id", j.photographer_id, ph[0]?.user_id ?? null);
    push(j.id, "editor_id", j.editor_id, ed[0]?.user_id ?? null);
    if (j.editor_id) {
      const terminal = j.status_category === "completed" || j.status_category === "cancelled";
      if (inactive.has(j.editor_id) && !terminal && !keptKeys.has(`${j.editor_id}|${j.id}`)) {
        structural.push({ check: "active_job_held_by_inactive_editor", jobId: j.id, detail: `editor ${j.editor_id} is inactive and the deactivation did not keep this job` });
      }
    }

    // --- revisions ---
    const revs = revisionsByJob.get(j.id) ?? [];
    const rc = revs.reduce((max, r) => Math.max(max, r.revision_number), 0);
    push(j.id, "revision_count", j.revision_count, rc);
    const orv = revs.filter((r) => r.resolved_at === null);
    if (orv.length > 1) structural.push({ check: "at_most_one_open_revision", jobId: j.id, detail: `${orv.length}` });
    push(j.id, "open_revision_id", j.open_revision_id, orv[0]?.id ?? null);
    // The open revision is worked by the job's editor: an assignee who does not hold the
    // job could neither see it nor resolve it (§4.4: a different assignee reassigns the job).
    for (const r of orv) {
      const assignee = r.assignee_user_id;
      if (assignee && j.editor_id && assignee !== j.editor_id) {
        structural.push({ check: "open_revision_assignee_is_editor", jobId: j.id, detail: `revision ${r.id} assignee ${assignee} != jobs.editor_id ${j.editor_id}` });
      }
    }
    for (const r of revs) {
      if (!requestedRevisionIds.has(r.id)) {
        structural.push({ check: "revision_has_event", jobId: j.id, detail: `revision ${r.id} has no revision.requested event` });
      }
    }

    // --- counters / activity ---
    push(j.id, "reopened_count", j.reopened_count, seq.filter((t) => t.is_reopen === true).length);
    const lastEvent = lastEventByJob.get(j.id) ?? null;
    if (lastEvent) push(j.id, "last_activity_at", j.last_activity_at, lastEvent);
    else structural.push({ check: "job_has_events", jobId: j.id, detail: "no activity_events for job" });
  }

  structural.push(...(await rolesV2Invariants(tx, organisationId)));

  return {
    checkedAt: new Date().toISOString(),
    jobsChecked: jobs.length,
    drift,
    structural,
    ok: drift.length === 0 && structural.length === 0,
  };
}

/**
 * Roles v2 invariants (docs/ROLES.md §1.4). Org-level rows carry `jobId: null`.
 * The CHECK constraints and the users_keep_admin / users_client_link /
 * org_primary_owner triggers enforce most of these; this is the belt and braces
 * report (and the only check for rows loaded with guards off by db:seed:remote).
 */
async function rolesV2Invariants(tx: Tx, organisationId?: string): Promise<IntegrityReport["structural"]> {
  const out: IntegrityReport["structural"] = [];
  const org = (alias: string): SQL => (organisationId ? sql`AND ${sql.raw(alias)}.organisation_id = ${organisationId}` : sql``);

  const noAdmin = await execRows<{ id: string }>(
    tx,
    sql`SELECT o.id FROM organisations o WHERE NOT EXISTS (
          SELECT 1 FROM users a WHERE a.organisation_id = o.id AND a.role = 'photographer' AND a.is_admin AND a.is_active) ${organisationId ? sql`AND o.id = ${organisationId}` : sql``}`,
  );
  for (const r of noAdmin) out.push({ check: "org_has_active_admin", jobId: null, detail: `organisation ${r.id} has no active admin` });

  const badPrimary = await execRows<{ organisation_id: string; primary_owner_user_id: string | null }>(
    tx,
    sql`SELECT s.organisation_id, s.primary_owner_user_id FROM organisation_settings s
         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.primary_owner_user_id AND u.organisation_id = s.organisation_id
                             AND u.role = 'photographer' AND u.is_admin AND u.is_active) ${org("s")}`,
  );
  for (const r of badPrimary) {
    out.push({ check: "org_primary_owner_valid", jobId: null, detail: `organisation ${r.organisation_id}: primary owner ${r.primary_owner_user_id ?? "null"} is not an active admin` });
  }

  const badDefault = await execRows<{ organisation_id: string; default_photographer_user_id: string }>(
    tx,
    sql`SELECT s.organisation_id, s.default_photographer_user_id FROM organisation_settings s
         WHERE s.default_photographer_user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.default_photographer_user_id AND u.organisation_id = s.organisation_id
                             AND u.role = 'photographer') ${org("s")}`,
  );
  for (const r of badDefault) {
    out.push({ check: "org_default_photographer_valid", jobId: null, detail: `organisation ${r.organisation_id}: default photographer ${r.default_photographer_user_id} is not a photographer of the organisation` });
  }

  const badClientUsers = await execRows<{ id: string }>(
    tx,
    sql`SELECT u.id FROM users u WHERE u.role = 'client'
          AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = u.client_id AND c.organisation_id = u.organisation_id) ${org("u")}`,
  );
  for (const r of badClientUsers) out.push({ check: "client_user_client_in_org", jobId: null, detail: `client user ${r.id} is not linked to a client of their organisation` });

  const badEdges = await execRows<{ id: string; allowed_roles: unknown }>(
    tx,
    sql`SELECT t.id, t.allowed_roles FROM workflow_transitions t
         WHERE (jsonb_typeof(t.allowed_roles) <> 'array' OR jsonb_array_length(t.allowed_roles) = 0
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.allowed_roles) = 'array' THEN t.allowed_roles ELSE '[]'::jsonb END) r
                            WHERE r #>> '{}' NOT IN ('admin', 'photographer', 'editor'))) ${org("t")}`,
  );
  for (const r of badEdges) out.push({ check: "transition_roles_valid", jobId: null, detail: `transition ${r.id} allowed_roles ${JSON.stringify(r.allowed_roles)}` });

  const legacy = await execRows<{ id: string; role: string }>(
    tx,
    sql`SELECT u.id, u.role FROM users u WHERE u.role NOT IN ('photographer', 'editor', 'client') ${org("u")}`,
  );
  for (const r of legacy) out.push({ check: "no_legacy_roles", jobId: null, detail: `user ${r.id} has role ${r.role}` });

  const roleMismatch = await execRows<{ id: string; created_by_role: string; creator_role: string }>(
    tx,
    sql`SELECT j.id, j.created_by_role, e.metadata->>'creatorRole' AS creator_role FROM jobs j
          JOIN activity_events e ON e.job_id = j.id AND e.event_type = 'job.created'
         WHERE e.metadata ? 'creatorRole' AND e.metadata->>'creatorRole' <> j.created_by_role ${org("j")}`,
  );
  for (const r of roleMismatch) {
    out.push({ check: "job_created_by_role_matches", jobId: r.id, detail: `jobs.created_by_role=${r.created_by_role} job.created creatorRole=${r.creator_role}` });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  CLI entry: `tsx src/db/verify.ts` — exits 1 on drift                */
/* ------------------------------------------------------------------ */

const isDirectRun =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /[\\/]verify\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  void (async () => {
    const { getDb, dbReady, closeDb } = await import("./index");
    try {
      await dbReady();
      const report = await verifyDerived(getDb());
      process.stdout.write(
        `db:verify — ${report.jobsChecked} jobs checked, ${report.drift.length} drift, ${report.structural.length} structural issues\n`,
      );
      for (const d of report.drift.slice(0, 50)) {
        process.stdout.write(`  drift   ${d.jobId} ${d.column}: stored=${JSON.stringify(d.stored)} derived=${JSON.stringify(d.derived)}\n`);
      }
      for (const s of report.structural.slice(0, 50)) {
        process.stdout.write(`  invariant ${s.check} ${s.jobId ?? "-"}: ${s.detail}\n`);
      }
      if (!report.ok) process.exitCode = 1;
    } catch (err) {
      process.stderr.write(`db:verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  })();
}
