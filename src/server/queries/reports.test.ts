import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, projects } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { buildCsv, csvFileName, escapeCsvCell } from "@/lib/csv";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { resolveRangeInput } from "./metrics";
import { getReport, reportFileName, toCsv } from "./reports";
import { moveJob } from "./test-history";

const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026 11:00 Sydney

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set(NOW);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
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
  it("resolves presets in the org timezone and passes resolved ranges through", () => {
    const ctx = contextFor(db, ids.users.manager);
    const week = resolveRangeInput(ctx, { range: "this_week" });
    expect(week).toMatchObject({ preset: "this_week", from: "2026-10-04T13:00:00.000Z", to: "2026-10-11T13:00:00.000Z" });
    const last7 = resolveRangeInput(ctx, { range: "last_7_days" });
    expect(last7.from).toBe("2026-10-01T14:00:00.000Z"); // 2 Oct 00:00 AEST (+10, before DST)
    expect(last7.to).toBe("2026-10-08T13:00:00.000Z");
    expect(resolveRangeInput(ctx, week)).toBe(week);
    const custom = resolveRangeInput(ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(custom.preset).toBe("custom");
    expect(custom.from).toBe("2026-08-31T14:00:00.000Z");
    expect(custom.to).toBe("2026-09-30T14:00:00.000Z");
    expect(resolveRangeInput(ctx, undefined).preset).toBe("last_30_days");
  });

  it("rejects malformed ranges with a 400", () => {
    const ctx = contextFor(db, ids.users.manager);
    expect(() => resolveRangeInput(ctx, { range: "forever" })).toThrow(ValidationError);
    expect(() => resolveRangeInput(ctx, { from: "01/09/2026" })).toThrow(ValidationError);
    expect(() => resolveRangeInput(ctx, { from: "2026-09-30", to: "2026-09-01" })).toThrow(ValidationError);
  });
});

describe("getReport", () => {
  function scenario() {
    // created before the range, completed inside it
    const old = insertJobFixture(db, ids, { statusKey: "in_progress", at: "2026-08-20T00:00:00.000Z", dueDate: "2026-09-20T14:00:00.000Z" }).job;
    moveJob(db, ids, old.id, "submitted", "2026-09-10T00:00:00.000Z");
    moveJob(db, ids, old.id, "approved", "2026-09-11T00:00:00.000Z");
    moveJob(db, ids, old.id, "completed", "2026-09-12T00:00:00.000Z");
    // created inside the range, still open
    const fresh = insertJobFixture(db, ids, { statusKey: "new", at: "2026-09-15T00:00:00.000Z", name: '=cmd("calc"), evil' }).job;
    // created and finished before the range: excluded
    const before = insertJobFixture(db, ids, { statusKey: "completed", at: "2026-08-10T00:00:00.000Z" }).job;
    // created after the range: excluded
    const after = insertJobFixture(db, ids, { statusKey: "new", at: "2026-10-05T00:00:00.000Z" }).job;
    return { old, fresh, before, after };
  }
  const SEPT = { from: "2026-09-01", to: "2026-09-30" };

  it("production: jobs created, approved or completed in range only", () => {
    const s = scenario();
    const r = getReport(db, contextFor(db, ids.users.manager), "production", SEPT);
    expect(r.kind).toBe("production");
    expect(r.title).toContain("Production report");
    const numbers = r.rows.map((x) => x.jobNumber);
    expect(numbers).toEqual([s.old.jobNumber, s.fresh.jobNumber]);
    const oldRow = r.rows.find((x) => x.jobNumber === s.old.jobNumber);
    expect(oldRow?.turnaroundHours).toBe(22 * 24); // in_progress (20 Aug) → approved (11 Sep)
    expect(oldRow?.onTime).toBe(true);
    expect(r.totals?.name).toBe("2 jobs");
  });

  it("csv: header from labels, totals last, formula + comma + quote escaping", () => {
    const s = scenario();
    const r = getReport(db, contextFor(db, ids.users.manager), "production", SEPT);
    const csv = toCsv(r);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(r.columns.map((c) => c.label).join(","));
    expect(lines).toHaveLength(r.rows.length + 3); // header + rows + totals + trailing ""
    expect(lines[lines.length - 2].startsWith("Total,2 jobs")).toBe(true);
    expect(csv).toContain(`${s.fresh.jobNumber},"'=cmd(""calc""), evil"`);
    expect(reportFileName(r)).toBe(`production-report-${r.range.from.slice(0, 10)}-${r.range.to.slice(0, 10)}.csv`);
  });

  it("editors / photographers / business reports aggregate per person and client", () => {
    scenario();
    const ctx = contextFor(db, ids.users.owner);
    const ed = getReport(db, ctx, "editors", SEPT);
    const eve = ed.rows.find((x) => x.editor === "Eve Editor");
    expect(eve).toMatchObject({ approved: 1, completed: 1, onTimePercent: 100, revisionRate: 0 });
    expect(ed.rows.some((x) => String(x.editor).includes("Iris"))).toBe(false); // inactive, no data

    const ph = getReport(db, ctx, "photographers", SEPT);
    expect(ph.rows.find((x) => x.photographer === "Pia Photographer")).toMatchObject({ created: 1, submitted: 1, completed: 1 });

    db.insert(clients).values({ id: "c-evil", organisationId: ids.organisationId, name: "=HYPERLINK(\"x\")", createdAt: NOW, updatedAt: NOW }).run();
    db.insert(projects).values({ id: "p-evil", organisationId: ids.organisationId, clientId: "c-evil", name: "Evil St", createdAt: NOW, updatedAt: NOW }).run();
    insertJobFixture(db, ids, { statusKey: "new", projectId: "p-evil", at: "2026-09-20T00:00:00.000Z" });
    const biz = getReport(db, ctx, "business", SEPT);
    expect(biz.rows.map((x) => x.client)).toEqual(["=HYPERLINK(\"x\")", "Harbour Realty"]);
    expect(biz.totals).toMatchObject({ created: 2, completed: 1, approved: 1 });
    expect(toCsv(biz)).toContain('"\'=HYPERLINK(""x"")",1,0,0,0');
  });

  it("guards: unknown kind 404, editors 403, foreign rows never appear", () => {
    scenario();
    const other = seedMinimalOrg(db, { slug: "other" });
    insertJobFixture(db, other, { statusKey: "new", at: "2026-09-15T00:00:00.000Z", name: "Foreign job" });
    const ctx = contextFor(db, ids.users.manager);
    expect(() => getReport(db, ctx, "salaries", SEPT)).toThrow(NotFoundError);
    expect(() => getReport(db, contextFor(db, ids.users.editor1), "production", SEPT)).toThrow(ForbiddenError);
    expect(toCsv(getReport(db, ctx, "production", SEPT))).not.toContain("Foreign job");
  });
});
