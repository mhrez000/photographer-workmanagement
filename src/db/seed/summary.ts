/**
 * Post-seed report: counts per category, spec §39 minimums (hard
 * assertions) and the §12 scenario checks (bands, bottlenecks, special
 * cases). Pure reads (raw SQL through `execRows`, `?` placeholders bound
 * as parameters by `rawSql`).
 */
import { sql, type SQL } from "drizzle-orm";
import { execRows, type Db } from "@/db/index";
import { DEFAULT_JOB_TYPES, DEMO_ACCOUNTS, STATUS_CATEGORIES } from "@/lib/constants";
import { ACTIVE_STAGE_CATEGORIES, STAGES, STAGE_TABS, stageOf, type Stage } from "@/lib/stages";
import { addCivilDays, civilDate, startOfCivilDayIso } from "@/lib/dates";
import { buildContextFromDb } from "@/server/auth/session";
import { computeWorkloads } from "@/server/queries/workloads";
import { computeBottlenecks } from "@/server/queries/bottlenecks";

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
  /** Hard checks fail the seed (spec §39 minimums). */
  hard: boolean;
}

export interface SeedReport {
  lines: string[];
  checks: Check[];
  ok: boolean;
}

/** `text` with `?` placeholders → a parameterised Drizzle SQL (values are never inlined). */
function rawSql(text: string, params: readonly unknown[]): SQL {
  const parts = text.split("?");
  if (parts.length - 1 !== params.length) throw new Error(`rawSql: ${parts.length - 1} placeholders but ${params.length} params: ${text}`);
  const chunks: SQL[] = [];
  parts.forEach((part, i) => {
    chunks.push(sql.raw(part));
    if (i < params.length) chunks.push(sql`${params[i]}`);
  });
  return sql.join(chunks);
}

export async function buildReport(db: Db, organisationId: string, nowMs: number): Promise<SeedReport> {
  const rows = <T extends Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => execRows<T>(db, rawSql(text, params));
  /** First column of the first row (0 when there is none). */
  const one = async <T = number>(text: string, ...params: unknown[]): Promise<T> => {
    const [row] = await rows(text, ...params);
    return (row ? Object.values(row)[0] : 0) as T;
  };
  const lines: string[] = [];
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail: string, hard = false) => checks.push({ label, ok, detail, hard });
  const org = organisationId;
  const nowIso = new Date(nowMs).toISOString();
  const tz = "Australia/Sydney";

  /* ---------------- counts ---------------- */
  const byCat = new Map<string, number>(
    (await rows<{ c: string; n: number }>("SELECT status_category AS c, COUNT(*) AS n FROM jobs WHERE organisation_id = ? GROUP BY status_category", org)).map(
      (r) => [r.c, r.n],
    ),
  );
  const totalJobs = [...byCat.values()].reduce((a, b) => a + b, 0);
  lines.push(`Northlight jobs by category (${totalJobs}):`);
  lines.push("  " + STATUS_CATEGORIES.map((c) => `${c}=${byCat.get(c) ?? 0}`).join("  "));

  const photographers = await one("SELECT COUNT(*) FROM users WHERE organisation_id = ? AND role = 'photographer'", org);
  const editors = await one("SELECT COUNT(*) FROM users WHERE organisation_id = ? AND role = 'editor'", org);
  const activeEditors = await one("SELECT COUNT(*) FROM users WHERE organisation_id = ? AND role = 'editor' AND is_active = true", org);
  const clients = await one("SELECT COUNT(*) FROM clients WHERE organisation_id = ?", org);
  const archivedClients = await one("SELECT COUNT(*) FROM clients WHERE organisation_id = ? AND archived_at IS NOT NULL", org);
  const projects = await one("SELECT COUNT(*) FROM projects WHERE organisation_id = ?", org);
  const overdue = await one(
    "SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category IN ('new','ready','assigned','accepted','in_progress','submitted','review','revision','resubmitted') AND due_date < ?",
    org,
    nowIso,
  );
  const awaitingReview = (byCat.get("submitted") ?? 0) + (byCat.get("review") ?? 0) + (byCat.get("resubmitted") ?? 0);
  const totals: [string, number][] = [
    ["users", await one("SELECT COUNT(*) FROM users WHERE organisation_id = ?", org)],
    ["photographers", photographers],
    ["editors", editors],
    ["active editors", activeEditors],
    ["teams", await one("SELECT COUNT(*) FROM teams WHERE organisation_id = ?", org)],
    ["clients", clients],
    ["archived clients", archivedClients],
    ["projects", projects],
    ["workflows", await one("SELECT COUNT(*) FROM workflows WHERE organisation_id = ?", org)],
    ["job types", await one("SELECT COUNT(*) FROM job_types WHERE organisation_id = ?", org)],
    ["activity events", await one("SELECT COUNT(*) FROM activity_events WHERE organisation_id = ?", org)],
    ["transitions", await one("SELECT COUNT(*) FROM job_status_transitions WHERE organisation_id = ?", org)],
    ["reattribution rows", await one("SELECT COUNT(*) FROM job_status_transitions WHERE organisation_id = ? AND kind = 'reattribution'", org)],
    ["migrations", await one("SELECT COUNT(*) FROM job_status_transitions WHERE organisation_id = ? AND kind = 'migration'", org)],
    ["revisions", await one("SELECT COUNT(*) FROM job_revisions WHERE organisation_id = ?", org)],
    ["comments", await one("SELECT COUNT(*) FROM job_comments WHERE organisation_id = ?", org)],
    ["comment replies", await one("SELECT COUNT(*) FROM job_comments WHERE organisation_id = ? AND parent_comment_id IS NOT NULL", org)],
    ["mentions", await one("SELECT COUNT(*) FROM comment_mentions WHERE organisation_id = ?", org)],
    ["notes", await one("SELECT COUNT(*) FROM job_notes WHERE organisation_id = ?", org)],
    ["links", await one("SELECT COUNT(*) FROM job_links WHERE organisation_id = ?", org)],
    ["replaced links", await one("SELECT COUNT(*) FROM job_links WHERE organisation_id = ? AND superseded_at IS NOT NULL", org)],
    ["work sessions", await one("SELECT COUNT(*) FROM work_sessions WHERE organisation_id = ?", org)],
    ["running sessions", await one("SELECT COUNT(*) FROM work_sessions WHERE organisation_id = ? AND ended_at IS NULL", org)],
    ["notifications", await one("SELECT COUNT(*) FROM notifications WHERE organisation_id = ?", org)],
    ["notifications read", await one("SELECT COUNT(*) FROM notifications WHERE organisation_id = ? AND read_at IS NOT NULL", org)],
    ["automations", await one("SELECT COUNT(*) FROM automations WHERE organisation_id = ?", org)],
    ["saved views", await one("SELECT COUNT(*) FROM saved_views WHERE organisation_id = ?", org)],
    ["dashboard layouts", await one("SELECT COUNT(*) FROM dashboard_layouts WHERE organisation_id = ?", org)],
  ];
  lines.push("Totals: " + totals.map(([k, v]) => `${k}=${v}`).join(", "));
  const runs = await rows<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM automation_runs WHERE organisation_id = ? GROUP BY status ORDER BY status",
    org,
  );
  lines.push("Automation runs: " + (runs.map((r) => `${r.status}=${r.n}`).join(", ") || "none"));

  /* ---------------- §39 minimums (hard) ---------------- */
  check("≥ 10 photographers", photographers >= 10, String(photographers), true);
  check("≥ 10 editors", editors >= 10, String(editors), true);
  check("≥ 30 clients", clients >= 30, String(clients), true);
  check("≥ 50 projects", projects >= 50, String(projects), true);
  check("≥ 150 jobs", totalJobs >= 150, String(totalJobs), true);
  check("completed jobs present", (byCat.get("completed") ?? 0) > 0, String(byCat.get("completed") ?? 0), true);
  check("overdue jobs present", overdue > 0, String(overdue), true);
  check("revision jobs present", (byCat.get("revision") ?? 0) > 0, String(byCat.get("revision") ?? 0), true);
  check("awaiting review present", awaitingReview > 0, String(awaitingReview), true);

  /* ---------------- roles v2 (docs/ROLES.md §13) — hard ---------------- */
  const legacyRoles = await one("SELECT COUNT(*) FROM users WHERE role NOT IN ('photographer', 'editor', 'client')");
  check("0 users with legacy roles (owner / manager)", legacyRoles === 0, String(legacyRoles), true);
  const badPrimary = await one(
    "SELECT COUNT(*) FROM organisation_settings s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.primary_owner_user_id AND u.organisation_id = s.organisation_id AND u.role = 'photographer' AND u.is_admin AND u.is_active)",
  );
  check("exactly one primary owner per org, an active admin", badPrimary === 0, `${badPrimary} org(s) without a valid primary owner`, true);
  const editorCreated = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND created_by_role = 'editor'", org);
  check("≥ 6 editor-created jobs", editorCreated >= 6, String(editorCreated), true);
  const cancelledCutoff = new Date(nowMs - 30 * 86_400_000).toISOString();
  const bestPortalUser = await one(
    `SELECT COALESCE(MAX(n), 0) FROM (
       SELECT u.id, COUNT(j.id) AS n FROM users u
         JOIN clients c ON c.id = u.client_id AND c.portal_enabled AND c.archived_at IS NULL
         JOIN jobs j ON j.organisation_id = u.organisation_id AND j.client_id = u.client_id
        WHERE u.organisation_id = ? AND u.role = 'client' AND u.is_active
          AND (j.status_category <> 'cancelled' OR j.cancelled_at >= ?)
          AND (j.shared_with_client OR EXISTS (SELECT 1 FROM projects p WHERE p.id = j.project_id AND p.shared_with_client))
        GROUP BY u.id) x`,
    org,
    cancelledCutoff,
  );
  check("≥ 1 portal user with ≥ 2 visible jobs", bestPortalUser >= 2, String(bestPortalUser), true);
  const sharedWithoutLinks = await one(
    `SELECT COUNT(*) FROM jobs j WHERE j.status_category IN ('delivered', 'completed')
       AND (j.shared_with_client OR EXISTS (SELECT 1 FROM projects p WHERE p.id = j.project_id AND p.shared_with_client))
       AND NOT EXISTS (SELECT 1 FROM job_links l WHERE l.job_id = j.id AND l.shared_with_client AND l.superseded_at IS NULL AND l.removed_at IS NULL)`,
  );
  check("every delivered shared job has ≥ 1 client-visible link", sharedWithoutLinks === 0, `${sharedWithoutLinks} without`, true);
  const portalUsers = await one("SELECT COUNT(*) FROM users WHERE organisation_id = ? AND role = 'client'", org);
  lines.push(`Roles v2: editor-created jobs=${editorCreated}, portal users=${portalUsers}, best portal user sees ${bestPortalUser} jobs`);

  /* ---------------- §12 scenario checks (planned jobs only) ---------------- */
  // The roles-v2 portal story (Harbourline Realty) and the editor-created jobs are scripted
  // on top of the 160 planned jobs (./portal.ts); the scenario targets describe the plan.
  const planned = (alias = "") =>
    `${alias}created_by_role = 'photographer' AND ${alias}client_id NOT IN (SELECT hc.id FROM clients hc WHERE hc.name = 'Harbourline Realty')`;
  const plannedByCat = new Map<string, number>(
    (
      await rows<{ c: string; n: number }>(
        `SELECT status_category AS c, COUNT(*) AS n FROM jobs WHERE organisation_id = ? AND ${planned()} GROUP BY status_category`,
        org,
      )
    ).map((r) => [r.c, r.n]),
  );
  const expect: [string, number][] = [
    ["new+ready", (plannedByCat.get("new") ?? 0) + (plannedByCat.get("ready") ?? 0)],
    ["assigned+accepted", (plannedByCat.get("assigned") ?? 0) + (plannedByCat.get("accepted") ?? 0)],
    ["in_progress", plannedByCat.get("in_progress") ?? 0],
    ["submitted+review", (plannedByCat.get("submitted") ?? 0) + (plannedByCat.get("review") ?? 0)],
    ["revision", plannedByCat.get("revision") ?? 0],
    ["resubmitted", plannedByCat.get("resubmitted") ?? 0],
    ["approved+delivered", (plannedByCat.get("approved") ?? 0) + (plannedByCat.get("delivered") ?? 0)],
    ["completed", plannedByCat.get("completed") ?? 0],
    ["cancelled", plannedByCat.get("cancelled") ?? 0],
  ];
  const target: Record<string, number> = {
    "new+ready": 12,
    "assigned+accepted": 14,
    in_progress: 24,
    "submitted+review": 16,
    revision: 12,
    resubmitted: 8,
    "approved+delivered": 14,
    completed: 52,
    cancelled: 8,
  };
  for (const [k, v] of expect) check(`bucket ${k} = ${target[k]}`, v === target[k], String(v));

  const inProgressOverdue = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'in_progress' AND due_date < ?", org, nowIso);
  check("8 in_progress overdue", inProgressOverdue === 8, String(inProgressOverdue));
  const revisionOverdue = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'revision' AND due_date < ?", org, nowIso);
  check("3 revision overdue", revisionOverdue === 3, String(revisionOverdue));
  const paused = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND is_paused = true", org);
  check("2 paused", paused === 2, String(paused));
  const reviewWaiting = await one(
    "SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category IN ('submitted','review') AND status_entered_at < ?",
    org,
    new Date(nowMs - 24 * 3_600_000).toISOString(),
  );
  check("8 submitted/review waiting > 24 h", reviewWaiting === 8, String(reviewWaiting));
  const reviewPast = await one(
    "SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category IN ('submitted','review','resubmitted') AND review_due_date < ?",
    org,
    nowIso,
  );
  check("3 past review_due_date", reviewPast === 3, String(reviewPast));
  const rev2 = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'revision' AND revision_count = 2", org);
  const rev3 = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'revision' AND revision_count = 3", org);
  check("revision bucket: 4 at #2, 1 at #3", rev2 === 4 && rev3 === 1, `#2=${rev2} #3=${rev3}`);
  const [comp = { z: 0, o: 0, t: 0, late: 0 }] = await rows<{ z: number; o: number; t: number; late: number }>(
    `SELECT COUNT(*) FILTER (WHERE revision_count = 0) AS z, COUNT(*) FILTER (WHERE revision_count = 1) AS o, COUNT(*) FILTER (WHERE revision_count >= 2) AS t, COUNT(*) FILTER (WHERE was_on_time = false) AS late FROM jobs WHERE organisation_id = ? AND status_category = 'completed' AND ${planned()}`,
    org,
  );
  check("completed: 30×0 / 16×1 / 6×2+ revisions", comp.z === 30 && comp.o === 16 && comp.t === 6, `${comp.z}/${comp.o}/${comp.t}`);
  check("4 completed late", comp.late === 4, String(comp.late));

  const today = civilDate(new Date(nowMs), tz) as string;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addCivilDays(today, -((dow + 6) % 7));
  const weekStart = startOfCivilDayIso(monday, tz);
  const lastWeekStart = startOfCivilDayIso(addCivilDays(monday, -7), tz);
  const thisWeek = await one(`SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'completed' AND completed_at >= ? AND ${planned()}`, org, weekStart);
  const lastWeek = await one(
    `SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'completed' AND completed_at >= ? AND completed_at < ? AND ${planned()}`,
    org,
    lastWeekStart,
    weekStart,
  );
  check("12 completed this week / 10 last week", thisWeek === 12 && lastWeek === 10, `${thisWeek} / ${lastWeek}`);
  const reopened = await one(
    "SELECT COUNT(*) FROM jobs j WHERE j.organisation_id = ? AND j.reopened_count > 0 AND j.completed_at >= ? AND EXISTS (SELECT 1 FROM job_status_transitions t WHERE t.job_id = j.id AND t.to_category = 'completed' AND t.entered_at >= ? AND t.entered_at < ?)",
    org,
    weekStart,
    lastWeekStart,
    weekStart,
  );
  check("2 completed last week → reopened → re-completed this week", reopened === 2, String(reopened));
  const restored = await one("SELECT COUNT(*) FROM activity_events WHERE organisation_id = ? AND event_type = 'job.restored'", org);
  check("1 restored job", restored === 1, String(restored));
  const midEdit = await one(
    "SELECT COUNT(DISTINCT job_id) FROM activity_events WHERE organisation_id = ? AND event_type = 'job.stage_reattributed'",
    org,
  );
  check("≥ 5 jobs re-attributed mid-stage", midEdit >= 5, String(midEdit));
  const dueChanges = await one("SELECT COUNT(DISTINCT job_id) FROM activity_events WHERE organisation_id = ? AND event_type = 'job.due_date_changed'", org);
  check("5 jobs with due-date changes", dueChanges === 5, String(dueChanges));
  const replaced = await one("SELECT COUNT(*) FROM job_links WHERE organisation_id = ? AND superseded_at IS NOT NULL", org);
  check("10 replaced links", replaced === 10, String(replaced));
  const migrations = await one("SELECT COUNT(*) FROM job_status_transitions WHERE organisation_id = ? AND kind = 'migration'", org);
  check("1 workflow migration", migrations === 1, String(migrations));
  const running = await one("SELECT COUNT(*) FROM work_sessions WHERE organisation_id = ? AND ended_at IS NULL", org);
  const sessionJobs = await one("SELECT COUNT(DISTINCT s.job_id) FROM work_sessions s JOIN jobs j ON j.id = s.job_id WHERE s.organisation_id = ? AND j.status_category = 'in_progress'", org);
  check("in_progress: 6 with sessions incl. 1 running", running === 1 && sessionJobs === 6, `with sessions=${sessionJobs} running=${running}`);
  const noRaw = await one(
    `SELECT COUNT(*) FROM jobs j WHERE j.organisation_id = ? AND ${planned("j.")} AND NOT EXISTS (SELECT 1 FROM job_links l WHERE l.job_id = j.id AND l.kind = 'raw_files')`,
    org,
  );
  check("every planned job has raw_files", noRaw === 0, `${noRaw} without`);
  const heldByInactive = await one(
    "SELECT COUNT(*) FROM jobs j JOIN users u ON u.id = j.editor_id WHERE j.organisation_id = ? AND u.is_active = false AND j.status_category NOT IN ('completed','cancelled')",
    org,
  );
  check("2 open jobs held by deactivated editor11", heldByInactive === 2, String(heldByInactive));
  const read = await one("SELECT COUNT(*) FROM notifications WHERE organisation_id = ? AND read_at IS NOT NULL", org);
  const allN = await one("SELECT COUNT(*) FROM notifications WHERE organisation_id = ?", org);
  const pct = allN ? Math.round((read / allN) * 100) : 0;
  check("~70 % notifications read", pct >= 60 && pct <= 80, `${pct}% of ${allN}`);
  const weekAgo = new Date(nowMs - 7 * 86_400_000).toISOString();
  const revThisWeek = await one("SELECT COUNT(*) FROM job_revisions WHERE organisation_id = ? AND requested_at >= ?", org, weekAgo);
  const revPrev4 = await one(
    "SELECT COUNT(*) FROM job_revisions WHERE organisation_id = ? AND requested_at >= ? AND requested_at < ?",
    org,
    new Date(nowMs - 35 * 86_400_000).toISOString(),
    weekAgo,
  );
  lines.push(`Revisions requested: last 7 days=${revThisWeek}, previous 4 weeks=${revPrev4} (≈${(revPrev4 / 4).toFixed(1)}/week)`);

  // The primary owner (roles v2: an admin photographer).
  const ownerId = await one<string>("SELECT primary_owner_user_id FROM organisation_settings WHERE organisation_id = ?", org);
  const ctx = await buildContextFromDb(db, ownerId, { now: () => nowIso });
  if (ctx) {
    const workloads = await computeWorkloads(db, ctx, { now: nowIso });
    const band = async (email: string) => {
      const id = await one<string>("SELECT id FROM users WHERE email = ?", email);
      const row = workloads.rows.find((r) => r.editor.id === id);
      return row ? `${row.band} (active ${row.active}, due≤48h ${row.dueWithin48h}, overdue ${row.overdue}, ratio ${row.ratio.toFixed(2)}, ${row.bandReason})` : "missing";
    };
    const e3Id = await one<string>("SELECT id FROM users WHERE email = 'editor03@studio.test'");
    const e7Id = await one<string>("SELECT id FROM users WHERE email = 'editor07@studio.test'");
    const e3 = workloads.rows.find((r) => r.editor.id === e3Id);
    const e7 = workloads.rows.find((r) => r.editor.id === e7Id);
    check("editor03 overloaded (14 active, 5 due ≤ 48 h)", e3?.band === "overloaded" && e3.active === 14 && e3.dueWithin48h === 5, await band("editor03@studio.test"));
    check("editor07 near capacity", e7?.band === "near_capacity", await band("editor07@studio.test"));
    const bands = workloads.rows.map((r) => `${r.editor.name.split(" ")[0]}:${r.band[0]}${r.active}`).join(" ");
    lines.push(`Workload bands (h/n/o + active): ${bands}`);
    const alerts = await computeBottlenecks(db, ctx, { now: nowIso, workloads });
    lines.push("Bottlenecks: " + (alerts.map((a) => `${a.kind}(${a.count})`).join(", ") || "none"));
    for (const kind of ["review", "editor_overloaded", "revision_spike", "unassigned_backlog", "editor_unavailable", "review_overdue"]) {
      check(`bottleneck ${kind} fires`, alerts.some((a) => a.kind === kind), alerts.find((a) => a.kind === kind)?.message ?? "not firing");
    }
  }

  return { lines, checks, ok: checks.every((c) => c.ok || !c.hard) };
}

/* ------------------------------------------------------------------ */
/*  Seed profile "small" (SIMPLIFICATION-PLAN §8 demo)                  */
/* ------------------------------------------------------------------ */

/**
 * Report + hard checks for the small demo: every one of the five stages is represented, late jobs, a
 * Round 2, a Done-not-sent, a cancelled job, one portal client with shared delivered work and a feedback
 * thread, time tracking OFF, no automations, Advanced tools OFF, the four login-box accounts. The §39
 * minimums do not apply (they describe the 160-job fixture).
 */
export async function buildSmallReport(db: Db, organisationId: string, nowMs: number): Promise<SeedReport> {
  const rows = <T extends Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => execRows<T>(db, rawSql(text, params));
  const one = async <T = number>(text: string, ...params: unknown[]): Promise<T> => {
    const [row] = await rows(text, ...params);
    return (row ? Object.values(row)[0] : 0) as T;
  };
  const lines: string[] = [];
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail: string, hard = true) => checks.push({ label, ok, detail, hard });
  const org = organisationId;
  const nowIso = new Date(nowMs).toISOString();

  const byCat = new Map<string, number>(
    (await rows<{ c: string; n: number }>("SELECT status_category AS c, COUNT(*) AS n FROM jobs WHERE organisation_id = ? GROUP BY status_category", org)).map(
      (r) => [r.c, r.n],
    ),
  );
  const byStage: Record<Stage, number> = { needs_editor: 0, with_editor: 0, ready_to_check: 0, changes_asked: 0, done: 0, cancelled: 0 };
  for (const c of STATUS_CATEGORIES) byStage[stageOf(c)] += byCat.get(c) ?? 0;
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  lines.push(`Northlight (small) jobs by stage (${total}): ${STAGES.map((s) => `${s}=${byStage[s]}`).join("  ")}`);
  lines.push("  by status: " + STATUS_CATEGORIES.map((c) => `${c}=${byCat.get(c) ?? 0}`).join("  "));

  const active = ACTIVE_STAGE_CATEGORIES.map((c) => `'${c}'`).join(",");
  const late = await one(`SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category IN (${active}) AND due_date < ?`, org, nowIso);
  const round2 = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'resubmitted' AND revision_count >= 1", org);
  const notSent = byCat.get("approved") ?? 0;
  const users = await rows<{ email: string; role: string; is_admin: boolean }>("SELECT email, role, is_admin FROM users WHERE organisation_id = ? ORDER BY email", org);
  const automations = await one("SELECT COUNT(*) FROM automations WHERE organisation_id = ?", org);
  const [settings] = await rows<{ time_tracking_enabled: boolean; advanced_tools_enabled: boolean }>(
    "SELECT time_tracking_enabled, advanced_tools_enabled FROM organisation_settings WHERE organisation_id = ?",
    org,
  );
  const portalVisible = await one(
    `SELECT COUNT(*) FROM jobs j WHERE j.organisation_id = ? AND j.status_category IN ('delivered','completed')
       AND (j.shared_with_client OR EXISTS (SELECT 1 FROM projects p WHERE p.id = j.project_id AND p.shared_with_client))
       AND EXISTS (SELECT 1 FROM job_links l WHERE l.job_id = j.id AND l.shared_with_client AND l.superseded_at IS NULL AND l.removed_at IS NULL)`,
    org,
  );
  const deliveryNotes = await one("SELECT COUNT(*) FROM job_notes WHERE organisation_id = ? AND kind = 'delivery' AND archived_at IS NULL", org);
  const feedbackThreads = await one("SELECT COUNT(*) FROM job_comments WHERE organisation_id = ? AND kind = 'client_feedback' AND parent_comment_id IS NULL", org);
  const feedbackReplies = await one("SELECT COUNT(*) FROM job_comments WHERE organisation_id = ? AND kind = 'client_feedback' AND parent_comment_id IS NOT NULL", org);
  const projects = await one("SELECT COUNT(*) FROM projects WHERE organisation_id = ?", org);
  const lateSummaries = await one("SELECT COUNT(*) FROM notifications WHERE organisation_id = ? AND type = 'job_overdue'", org);
  const usualDays = await one("SELECT COUNT(*) FROM job_types WHERE organisation_id = ? AND usual_days_to_edit IS NOT NULL", org);

  lines.push(
    `Totals: users=${users.length}, projects=${projects}, late=${late}, round2=${round2}, approved(not sent)=${notSent}, automations=${automations}, late summaries=${lateSummaries}`,
  );

  for (const stage of STAGE_TABS) check(`stage ${stage} represented`, byStage[stage] >= 1, String(byStage[stage]));
  check("a cancelled job", byStage.cancelled >= 1, String(byStage.cancelled));
  check("about 20 jobs (15–30)", total >= 15 && total <= 30, String(total));
  check("≥ 3 late jobs (red chip + filter)", late >= 3, String(late));
  check("a Round 2 ready to check", round2 >= 1, String(round2));
  check("a Done · not sent to client (Approved)", notSent >= 1, String(notSent));
  check("a Delivered job", (byCat.get("delivered") ?? 0) >= 1, String(byCat.get("delivered") ?? 0));
  check("≥ 1 shared delivered job with a client-visible link", portalVisible >= 1, String(portalVisible));
  check("a delivery note", deliveryNotes >= 1, String(deliveryNotes));
  check("a feedback thread with a reply", feedbackThreads >= 1 && feedbackReplies >= 1, `threads=${feedbackThreads} replies=${feedbackReplies}`);
  check("time tracking OFF", settings?.time_tracking_enabled === false, String(settings?.time_tracking_enabled));
  check("NO automations", automations === 0, String(automations));
  check("Advanced tools OFF", settings?.advanced_tools_enabled === false, String(settings?.advanced_tools_enabled));
  check("every type of shoot has usual days to edit", usualDays === DEFAULT_JOB_TYPES.length, `${usualDays}/${DEFAULT_JOB_TYPES.length}`);
  const emails = new Set(users.map((u) => u.email));
  for (const demo of DEMO_ACCOUNTS) check(`login box account ${demo.email}`, emails.has(demo.email), emails.has(demo.email) ? "present" : "missing");
  check("1 owner + 1 extra photographer + 3 editors + 1 client user", users.length === 6, users.map((u) => `${u.email}:${u.role}${u.is_admin ? "(admin)" : ""}`).join(" "));
  const extra = users.find((u) => u.email === "photographer01@studio.test");
  check("the extra photographer is not an admin", extra !== undefined && !extra.is_admin, String(extra?.is_admin));
  const badPrimary = await one(
    "SELECT COUNT(*) FROM organisation_settings s WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.primary_owner_user_id AND u.organisation_id = s.organisation_id AND u.role = 'photographer' AND u.is_admin AND u.is_active)",
  );
  check("exactly one primary owner per org, an active admin", badPrimary === 0, `${badPrimary} org(s) without a valid primary owner`);
  const legacyRoles = await one("SELECT COUNT(*) FROM users WHERE role NOT IN ('photographer', 'editor', 'client')");
  check("0 users with legacy roles", legacyRoles === 0, String(legacyRoles));

  return { lines, checks, ok: checks.every((c) => c.ok || !c.hard) };
}
