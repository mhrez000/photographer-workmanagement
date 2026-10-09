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
 */
import type Database from "better-sqlite3";
import type { IntegrityReport } from "@/lib/types";

type Row = Record<string, unknown>;

interface JobRow {
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

/**
 * Recompute every derived job column from the ledgers and compare. All reads
 * run in ONE read transaction (a single WAL snapshot): without it a job
 * written between two of the queries showed up as drift on a busy server.
 */
export function verifyDerived(sqlite: Database.Database, organisationId?: string): IntegrityReport {
  return sqlite.transaction(() => collectReport(sqlite, organisationId)).deferred();
}

function collectReport(sqlite: Database.Database, organisationId?: string): IntegrityReport {
  const drift: IntegrityReport["drift"] = [];
  const structural: IntegrityReport["structural"] = [];
  const orgFilter = organisationId ? "WHERE j.organisation_id = ?" : "";
  const params = organisationId ? [organisationId] : [];

  const jobs = sqlite
    .prepare(
      `SELECT j.id, j.status_id, j.status_category, j.previous_status_id, j.status_entered_at,
              j.photographer_id, j.editor_id, j.revision_count, j.open_revision_id,
              j.completed_at, j.cancelled_at, j.reopened_count, j.last_activity_at,
              j.client_id, p.client_id AS project_client_id,
              j.workflow_id, s.workflow_id AS status_workflow_id, s.category AS status_actual_category
         FROM jobs j
         JOIN projects p ON p.id = j.project_id
         JOIN workflow_statuses s ON s.id = j.status_id
         ${orgFilter}`,
    )
    .all(...params) as JobRow[];

  const openTransition = sqlite.prepare(
    `SELECT id, to_status_id, from_status_id, to_category, entered_at, is_reopen FROM job_status_transitions WHERE job_id = ? AND exited_at IS NULL`,
  );
  const transitionSeq = sqlite.prepare(
    `SELECT sequence, entered_at, exited_at, kind, to_category, id FROM job_status_transitions WHERE job_id = ? ORDER BY sequence`,
  );
  const openAssignment = sqlite.prepare(
    `SELECT user_id FROM job_assignments WHERE job_id = ? AND role = ? AND unassigned_at IS NULL`,
  );
  const maxRevision = sqlite.prepare(`SELECT MAX(revision_number) AS n FROM job_revisions WHERE job_id = ?`);
  const openRevision = sqlite.prepare(`SELECT id, assignee_user_id FROM job_revisions WHERE job_id = ? AND resolved_at IS NULL`);
  const maxEvent = sqlite.prepare(`SELECT MAX(created_at) AS at FROM activity_events WHERE job_id = ?`);
  const reopenCount = sqlite.prepare(`SELECT COUNT(*) AS n FROM job_status_transitions WHERE job_id = ? AND is_reopen = 1`);
  const openSessions = sqlite.prepare(`SELECT COUNT(*) AS n FROM work_sessions WHERE job_id = ? AND ended_at IS NULL`);
  const statusChangedEvent = sqlite.prepare(
    `SELECT 1 FROM activity_events WHERE job_id = ? AND event_type = 'job.status_changed' AND json_extract(metadata, '$.transitionId') = ? LIMIT 1`,
  );
  const revisionEvents = sqlite.prepare(
    `SELECT r.id FROM job_revisions r WHERE r.job_id = ? AND NOT EXISTS (
        SELECT 1 FROM activity_events e WHERE e.event_type = 'revision.requested' AND json_extract(e.metadata, '$.revisionId') = r.id)`,
  );
  const inactiveEditor = sqlite.prepare(`SELECT is_active FROM users WHERE id = ?`);
  // "Flagged" = the editor's latest deactivation explicitly KEPT this job (neither reassign nor
  // unassign was chosen): the editor-unavailable bottleneck case, not an inconsistency (§2.8).
  const keptOnDeactivation = sqlite.prepare(
    `SELECT 1 FROM activity_events e, json_each(e.metadata, '$.openJobs') o
      WHERE e.event_type = 'user.deactivated' AND e.entity_id = ?
        AND e.rowid = (SELECT MAX(e2.rowid) FROM activity_events e2 WHERE e2.event_type = 'user.deactivated' AND e2.entity_id = e.entity_id)
        AND json_extract(o.value, '$.jobId') = ? AND json_extract(o.value, '$.role') = 'editor' AND json_extract(o.value, '$.action') = 'kept'
      LIMIT 1`,
  );

  const push = (jobId: string, column: string, stored: unknown, derived: unknown) => {
    if (stored !== derived) drift.push({ jobId, column, stored, derived });
  };

  for (const j of jobs) {
    // --- consistency that triggers also enforce (belt and braces) ---
    if (j.project_client_id !== j.client_id) structural.push({ check: "client_matches_project", jobId: j.id, detail: `jobs.client_id=${j.client_id} projects.client_id=${j.project_client_id}` });
    if (j.status_workflow_id !== j.workflow_id) structural.push({ check: "status_in_workflow", jobId: j.id, detail: `status workflow ${j.status_workflow_id} != job workflow ${j.workflow_id}` });
    push(j.id, "status_category", j.status_category, j.status_actual_category);

    // --- open transition ---
    const open = openTransition.all(j.id) as Row[];
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
        const s = openSessions.get(j.id) as { n: number };
        if (s.n > 0) structural.push({ check: "no_open_session_on_terminal", jobId: j.id, detail: `${s.n} running sessions` });
      }
    }

    // --- sequence contiguity, monotonic times, event linkage ---
    const seq = transitionSeq.all(j.id) as Row[];
    let prevExit: string | null = null;
    seq.forEach((t, i) => {
      if (t.sequence !== i + 1) structural.push({ check: "sequence_contiguous", jobId: j.id, detail: `expected ${i + 1} got ${t.sequence}` });
      if (prevExit && typeof t.entered_at === "string" && t.entered_at < prevExit) structural.push({ check: "entered_after_previous_exit", jobId: j.id, detail: `seq ${t.sequence}` });
      if (i < seq.length - 1 && t.exited_at == null) structural.push({ check: "only_last_open", jobId: j.id, detail: `seq ${t.sequence} open but not last` });
      prevExit = (t.exited_at as string | null) ?? prevExit;
      if (t.kind === "transition" && !statusChangedEvent.get(j.id, t.id)) {
        structural.push({ check: "transition_has_event", jobId: j.id, detail: `transition ${t.id} has no job.status_changed event` });
      }
    });
    if (seq.length === 0) structural.push({ check: "has_creation_transition", jobId: j.id, detail: "no transition rows" });

    // --- people ---
    const ph = openAssignment.all(j.id, "photographer") as Row[];
    const ed = openAssignment.all(j.id, "editor") as Row[];
    if (ph.length > 1 || ed.length > 1) structural.push({ check: "one_open_assignment_per_role", jobId: j.id, detail: `photographer=${ph.length} editor=${ed.length}` });
    push(j.id, "photographer_id", j.photographer_id, (ph[0]?.user_id as string | undefined) ?? null);
    push(j.id, "editor_id", j.editor_id, (ed[0]?.user_id as string | undefined) ?? null);
    if (j.editor_id) {
      const u = inactiveEditor.get(j.editor_id) as { is_active: number } | undefined;
      const terminal = j.status_category === "completed" || j.status_category === "cancelled";
      if (u && !u.is_active && !terminal && !keptOnDeactivation.get(j.editor_id, j.id)) {
        structural.push({ check: "active_job_held_by_inactive_editor", jobId: j.id, detail: `editor ${j.editor_id} is inactive and the deactivation did not keep this job` });
      }
    }

    // --- revisions ---
    const rc = (maxRevision.get(j.id) as { n: number | null }).n ?? 0;
    push(j.id, "revision_count", j.revision_count, rc);
    const orv = openRevision.all(j.id) as Row[];
    if (orv.length > 1) structural.push({ check: "at_most_one_open_revision", jobId: j.id, detail: `${orv.length}` });
    push(j.id, "open_revision_id", j.open_revision_id, (orv[0]?.id as string | undefined) ?? null);
    // The open revision is worked by the job's editor: an assignee who does not hold the
    // job could neither see it nor resolve it (§4.4: a different assignee reassigns the job).
    for (const r of orv) {
      const assignee = r.assignee_user_id as string | null;
      if (assignee && j.editor_id && assignee !== j.editor_id) {
        structural.push({ check: "open_revision_assignee_is_editor", jobId: j.id, detail: `revision ${String(r.id)} assignee ${assignee} != jobs.editor_id ${j.editor_id}` });
      }
    }
    for (const r of revisionEvents.all(j.id) as Row[]) {
      structural.push({ check: "revision_has_event", jobId: j.id, detail: `revision ${r.id} has no revision.requested event` });
    }

    // --- counters / activity ---
    push(j.id, "reopened_count", j.reopened_count, (reopenCount.get(j.id) as { n: number }).n);
    const lastEvent = (maxEvent.get(j.id) as { at: string | null }).at;
    if (lastEvent) push(j.id, "last_activity_at", j.last_activity_at, lastEvent);
    else structural.push({ check: "job_has_events", jobId: j.id, detail: "no activity_events for job" });
  }

  return {
    checkedAt: new Date().toISOString(),
    jobsChecked: jobs.length,
    drift,
    structural,
    ok: drift.length === 0 && structural.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/*  CLI entry: `tsx src/db/verify.ts` — exits 1 on drift                */
/* ------------------------------------------------------------------ */

const isDirectRun =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  /[\\/]verify\.(ts|js|mts|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  void import("./index").then(({ sqlite }) => {
    const report = verifyDerived(sqlite);
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
  });
}
