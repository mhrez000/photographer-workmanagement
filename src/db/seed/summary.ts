/**
 * Post-seed report: counts per category, spec §39 minimums (hard
 * assertions) and the §12 scenario checks (bands, bottlenecks, special
 * cases). Pure reads (raw SQL through `execRows`, `?` placeholders bound
 * as parameters by `rawSql`).
 */
import { sql, type SQL } from "drizzle-orm";
import { execRows, type Db } from "@/db/index";
import { STATUS_CATEGORIES } from "@/lib/constants";
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

  /* ---------------- §12 scenario checks ---------------- */
  const expect: [string, number][] = [
    ["new+ready", (byCat.get("new") ?? 0) + (byCat.get("ready") ?? 0)],
    ["assigned+accepted", (byCat.get("assigned") ?? 0) + (byCat.get("accepted") ?? 0)],
    ["in_progress", byCat.get("in_progress") ?? 0],
    ["submitted+review", (byCat.get("submitted") ?? 0) + (byCat.get("review") ?? 0)],
    ["revision", byCat.get("revision") ?? 0],
    ["resubmitted", byCat.get("resubmitted") ?? 0],
    ["approved+delivered", (byCat.get("approved") ?? 0) + (byCat.get("delivered") ?? 0)],
    ["completed", byCat.get("completed") ?? 0],
    ["cancelled", byCat.get("cancelled") ?? 0],
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
    "SELECT COUNT(*) FILTER (WHERE revision_count = 0) AS z, COUNT(*) FILTER (WHERE revision_count = 1) AS o, COUNT(*) FILTER (WHERE revision_count >= 2) AS t, COUNT(*) FILTER (WHERE was_on_time = false) AS late FROM jobs WHERE organisation_id = ? AND status_category = 'completed'",
    org,
  );
  check("completed: 30×0 / 16×1 / 6×2+ revisions", comp.z === 30 && comp.o === 16 && comp.t === 6, `${comp.z}/${comp.o}/${comp.t}`);
  check("4 completed late", comp.late === 4, String(comp.late));

  const today = civilDate(new Date(nowMs), tz) as string;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addCivilDays(today, -((dow + 6) % 7));
  const weekStart = startOfCivilDayIso(monday, tz);
  const lastWeekStart = startOfCivilDayIso(addCivilDays(monday, -7), tz);
  const thisWeek = await one("SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'completed' AND completed_at >= ?", org, weekStart);
  const lastWeek = await one(
    "SELECT COUNT(*) FROM jobs WHERE organisation_id = ? AND status_category = 'completed' AND completed_at >= ? AND completed_at < ?",
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
    "SELECT COUNT(*) FROM jobs j WHERE j.organisation_id = ? AND NOT EXISTS (SELECT 1 FROM job_links l WHERE l.job_id = j.id AND l.kind = 'raw_files')",
    org,
  );
  check("every job has raw_files", noRaw === 0, `${noRaw} without`);
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

  const ownerId = await one<string>("SELECT id FROM users WHERE organisation_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", org);
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
