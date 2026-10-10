import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { clients, organisationSettings, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { buildCsv, csvFileName, escapeCsvCell } from "@/lib/csv";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { resolveRangeInput } from "./metrics";
import { getReport, reportFileName, toCsv } from "./reports";
import { moveJob } from "./test-history";

const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026 11:00 Sydney

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
});

afterEach(() => fakeClock.reset());

describe("csv", () => {
  it("quotes separators, quotes and newlines; doubles inner quotes", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell(" padded")).toBe('" padded"');
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(true)).toBe("true");
    expect(escapeCsvCell(Number.NaN)).toBe("");
  });

  it("neutralises formula injection in strings but keeps numbers numeric", () => {
    expect(escapeCsvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(escapeCsvCell("+61 400")).toBe("'+61 400");
    expect(escapeCsvCell("-2")).toBe("'-2");
    expect(escapeCsvCell("@cmd")).toBe("'@cmd");
    expect(escapeCsvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(escapeCsvCell(-2)).toBe("-2");
    expect(escapeCsvCell(1.5)).toBe("1.5");
  });

  it("builds CRLF documents and safe file names", () => {
    expect(buildCsv(["a", "b"], [[1, "x,y"]])).toBe('a,b\r\n1,"x,y"\r\n');
    expect(buildCsv(["a"], [], { bom: true }).startsWith("﻿")).toBe(true);
    expect(csvFileName("Editors Report: 2026/10")).toBe("editors-report-2026-10.csv");
  });
});

describe("ranges", () => {
  it("resolves presets in the org timezone and passes resolved ranges through", async () => {
    const ctx = await contextFor(db, ids.users.coAdmin);
    const week = await resolveRangeInput(ctx, { range: "this_week" });
    expect(week).toMatchObject({ preset: "this_week", from: "2026-10-04T13:00:00.000Z", to: "2026-10-11T13:00:00.000Z" });
    const last7 = await resolveRangeInput(ctx, { range: "last_7_days" });
    expect(last7.from).toBe("2026-10-01T14:00:00.000Z"); // 2 Oct 00:00 AEST (+10, before DST)
    expect(last7.to).toBe("2026-10-08T13:00:00.000Z");
    expect(await resolveRangeInput(ctx, week)).toBe(week);
    const custom = await resolveRangeInput(ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(custom.preset).toBe("custom");
    expect(custom.from).toBe("2026-08-31T14:00:00.000Z");
    expect(custom.to).toBe("2026-09-30T14:00:00.000Z");
    expect((await resolveRangeInput(ctx, undefined)).preset).toBe("last_30_days");
  });

  it("this_week honours organisation_settings.week_starts_on", async () => {
    const ctx = await contextFor(db, ids.users.coAdmin);
    await db.update(organisationSettings).set({ weekStartsOn: 0 }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const sunday = await resolveRangeInput(ctx, { range: "this_week" }, undefined, { db });
    expect(sunday.from).toBe("2026-10-03T14:00:00.000Z"); // Sun 4 Oct 00:00 AEST (DST starts 02:00 that day)
    expect(sunday.to).toBe("2026-10-10T13:00:00.000Z"); // Sun 11 Oct 00:00 AEDT
    expect((await resolveRangeInput(ctx, { range: "this_week" }, undefined, { weekStartsOn: 1 })).from).toBe("2026-10-04T13:00:00.000Z");
  });

  it("rejects malformed ranges with a 400", async () => {
    const ctx = await contextFor(db, ids.users.coAdmin);
    await expect(resolveRangeInput(ctx, { range: "forever" })).rejects.toThrow(ValidationError);
    await expect(resolveRangeInput(ctx, { from: "01/09/2026" })).rejects.toThrow(ValidationError);
    await expect(resolveRangeInput(ctx, { from: "2026-09-30", to: "2026-09-01" })).rejects.toThrow(ValidationError);
  });
});

describe("getReport", () => {
  async function scenario() {
    // created before the range, completed inside it
    const old = (await insertJobFixture(db, ids, { statusKey: "in_progress", at: "2026-08-20T00:00:00.000Z", dueDate: "2026-09-20T14:00:00.000Z" })).job;
    await moveJob(db, ids, old.id, "submitted", "2026-09-10T00:00:00.000Z");
    await moveJob(db, ids, old.id, "approved", "2026-09-11T00:00:00.000Z");
    await moveJob(db, ids, old.id, "completed", "2026-09-12T00:00:00.000Z");
    // created inside the range, still open
    const fresh = (await insertJobFixture(db, ids, { statusKey: "new", at: "2026-09-15T00:00:00.000Z", name: '=cmd("calc"), evil' })).job;
    // created and finished before the range: excluded
    const before = (await insertJobFixture(db, ids, { statusKey: "completed", at: "2026-08-10T00:00:00.000Z" })).job;
    // created after the range: excluded
    const after = (await insertJobFixture(db, ids, { statusKey: "new", at: "2026-10-05T00:00:00.000Z" })).job;
    return { old, fresh, before, after };
  }
  const SEPT = { from: "2026-09-01", to: "2026-09-30" };

  it("production: jobs created, approved or completed in range only", async () => {
    const s = await scenario();
    const r = await getReport(db, await contextFor(db, ids.users.coAdmin), "production", SEPT);
    expect(r.kind).toBe("production");
    expect(r.title).toContain("Production report");
    const numbers = r.rows.map((x) => x.jobNumber);
    expect(numbers).toEqual([s.old.jobNumber, s.fresh.jobNumber]);
    const oldRow = r.rows.find((x) => x.jobNumber === s.old.jobNumber);
    expect(oldRow?.turnaroundHours).toBe(22 * 24); // in_progress (20 Aug) → approved (11 Sep)
    expect(oldRow?.onTime).toBe(true);
    expect(r.totals?.name).toBe("2 jobs");
  });

  it("csv: header from labels, totals last, formula + comma + quote escaping", async () => {
    const s = await scenario();
    const r = await getReport(db, await contextFor(db, ids.users.coAdmin), "production", SEPT);
    const csv = toCsv(r);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(r.columns.map((c) => c.label).join(","));
    expect(lines).toHaveLength(r.rows.length + 3); // header + rows + totals + trailing ""
    expect(lines[lines.length - 2].startsWith("Total,2 jobs")).toBe(true);
    expect(csv).toContain(`${s.fresh.jobNumber},"'=cmd(""calc""), evil"`);
    // civil first / last day of the range in the org timezone (not the UTC slice of the bounds)
    expect(reportFileName(r, "Australia/Sydney")).toBe("production-report-2026-09-01-2026-09-30.csv");
  });

  it("csv: file name for this_month in October is the civil month", async () => {
    const r = await getReport(db, await contextFor(db, ids.users.coAdmin), "editors", { range: "this_month" });
    expect(r.range.from).toBe("2026-09-30T14:00:00.000Z"); // 1 Oct 00:00 AEST
    expect(reportFileName(r, "Australia/Sydney")).toBe("editors-report-2026-10-01-2026-10-31.csv");
  });

  it("csv: date cells are org-local 'YYYY-MM-DD HH:mm'; deadline columns are civil dates", async () => {
    const s = await scenario();
    const r = await getReport(db, await contextFor(db, ids.users.coAdmin), "production", SEPT);
    const lines = toCsv(r, "Australia/Sydney").split("\r\n");
    const header = lines[0].split(",");
    const row = lines.find((l) => l.startsWith(`${s.old.jobNumber},`))?.split(",") ?? [];
    const cell = (label: string) => row[header.indexOf(label)];
    expect(cell("Created")).toBe("2026-08-20 10:00"); // 2026-08-20T00:00Z in AEST
    expect(cell("Approved")).toBe("2026-09-11 10:00");
    expect(cell("Completed")).toBe("2026-09-12 10:00");
    expect(cell("Due")).toBe("2026-09-21"); // stored 2026-09-20T14:00Z = 21 Sep 00:00 AEST
    expect(lines.join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it("production turnaround total = business average for the same range (approved in range, unrounded)", async () => {
    await scenario();
    // touched in range but approved BEFORE it: must not move the total
    const early = (await insertJobFixture(db, ids, { statusKey: "in_progress", at: "2026-08-01T00:00:00.000Z" })).job;
    await moveJob(db, ids, early.id, "submitted", "2026-08-05T00:00:00.000Z");
    await moveJob(db, ids, early.id, "approved", "2026-08-07T00:00:00.000Z");
    await moveJob(db, ids, early.id, "completed", "2026-09-03T00:00:00.000Z");
    // a second in-range approval with a non-round turnaround
    const odd = (await insertJobFixture(db, ids, { statusKey: "in_progress", at: "2026-09-02T00:00:00.000Z" })).job;
    await moveJob(db, ids, odd.id, "submitted", "2026-09-02T05:00:00.000Z");
    await moveJob(db, ids, odd.id, "approved", "2026-09-02T07:20:33.000Z");
    const ctx = await contextFor(db, ids.users.owner);
    const prod = await getReport(db, ctx, "production", SEPT);
    const biz = await getReport(db, ctx, "business", SEPT);
    expect(prod.rows.map((x) => x.jobNumber)).toContain(early.jobNumber);
    expect(prod.totals?.turnaroundHours).toBe(biz.totals?.avgTurnaroundHours);
    expect(prod.totals?.turnaroundHours).not.toBeNull();
  });

  it("editors / photographers / business reports aggregate per person and client", async () => {
    await scenario();
    const ctx = await contextFor(db, ids.users.owner);
    const ed = await getReport(db, ctx, "editors", SEPT);
    const eve = ed.rows.find((x) => x.editor === "Eve Editor");
    expect(eve).toMatchObject({ approved: 1, completed: 1, onTimePercent: 100, revisionRate: 0 });
    expect(ed.rows.some((x) => String(x.editor).includes("Iris"))).toBe(false); // inactive, no data

    const ph = await getReport(db, ctx, "photographers", SEPT);
    expect(ph.rows.find((x) => x.photographer === "Pia Photographer")).toMatchObject({ created: 1, submitted: 1, completed: 1 });

    await db.insert(clients).values({ id: "c-evil", organisationId: ids.organisationId, name: "=HYPERLINK(\"x\")", createdAt: NOW, updatedAt: NOW });
    await db.insert(projects).values({ id: "p-evil", organisationId: ids.organisationId, clientId: "c-evil", name: "Evil St", createdAt: NOW, updatedAt: NOW });
    await insertJobFixture(db, ids, { statusKey: "new", projectId: "p-evil", at: "2026-09-20T00:00:00.000Z" });
    const biz = await getReport(db, ctx, "business", SEPT);
    expect(biz.rows.map((x) => x.client)).toEqual(["=HYPERLINK(\"x\")", "Harbour Realty"]);
    expect(biz.totals).toMatchObject({ created: 2, completed: 1, approved: 1 });
    expect(toCsv(biz)).toContain('"\'=HYPERLINK(""x"")",1,0,0,0');
  });

  it("guards: unknown kind 404, editors 403, foreign rows never appear", async () => {
    await scenario();
    const other = await seedMinimalOrg(db, { slug: "other" });
    await insertJobFixture(db, other, { statusKey: "new", at: "2026-09-15T00:00:00.000Z", name: "Foreign job" });
    const ctx = await contextFor(db, ids.users.coAdmin);
    await expect(getReport(db, ctx, "salaries", SEPT)).rejects.toThrow(NotFoundError);
    await expect(getReport(db, await contextFor(db, ids.users.editor1), "production", SEPT)).rejects.toThrow(ForbiddenError);
    expect(toCsv(await getReport(db, ctx, "production", SEPT))).not.toContain("Foreign job");
    await expect(getReport(db, await contextFor(db, ids.users.client), "production", SEPT)).rejects.toThrow(ForbiddenError);
    await expect(getReport(db, await contextFor(db, ids.users.photographer1), "production", SEPT)).rejects.toThrow(ForbiddenError);
  });

  it("an ⚑analytics member without See all jobs gets only visible jobs in job-level rows (aggregates stay org-wide)", async () => {
    const s = await scenario();
    const ownerJob = (await insertJobFixture(db, ids, { statusKey: "new", at: "2026-09-16T00:00:00.000Z", photographerId: ids.users.owner, createdByUserId: ids.users.owner })).job;
    await setUserFlags(db, ids.users.photographer2, { canViewAnalytics: true });
    const p2 = await contextFor(db, ids.users.photographer2);
    const rows = (await getReport(db, p2, "production", SEPT)).rows.map((x) => x.jobNumber);
    expect(rows).toEqual([]); // photographer2 manages none of these jobs
    const all = (await getReport(db, await contextFor(db, ids.users.owner), "production", SEPT)).rows.map((x) => x.jobNumber);
    expect(all).toEqual(expect.arrayContaining([s.old.jobNumber, s.fresh.jobNumber, ownerJob.jobNumber]));
    // with See all jobs the rows come back
    await setUserFlags(db, ids.users.photographer2, { canViewAllJobs: true });
    expect((await getReport(db, await contextFor(db, ids.users.photographer2), "production", SEPT)).rows.map((x) => x.jobNumber).sort()).toEqual([...all].sort());
  });
});
