import { describe, expect, it } from "vitest";
import { endOfCivilDayIso } from "./dates";
import {
  averageDaysToEdit,
  daysFromToday,
  daysLateBySubmit,
  finishedPerWeek,
  isDeskFull,
  isLateCivil,
  MIN_JOBS_FOR_RATES,
  neededChangesPct,
  numberDelta,
  onTimeBySubmitPct,
  percent,
  periodRange,
  previousPeriodRange,
  submittedOnTime,
  weekBuckets,
  type FinishedJobLike,
} from "./editorMetrics";

const TZ = "Australia/Sydney";
const NOW = "2026-10-08T00:00:00.000Z"; // Thu 8 Oct 2026, 11:00 AEDT
const due = (civil: string) => endOfCivilDayIso(civil, TZ);

function finished(over: Partial<FinishedJobLike> = {}): FinishedJobLike {
  return { approvedAt: "2026-10-07T00:00:00.000Z", dueDate: due("2026-10-05"), dueDateAtApproval: due("2026-10-05"), firstSubmittedAt: "2026-10-04T23:00:00.000Z", revisionCount: 0, ...over };
}

describe("periodRange (org timezone, civil months)", () => {
  it("this month = 1 Oct 00:00 AEST → 1 Nov 00:00 AEDT (DST started 4 Oct)", () => {
    const r = periodRange("this_month", TZ, NOW);
    expect(r).toMatchObject({ period: "this_month", label: "This month" });
    expect(r.from).toBe("2026-09-30T14:00:00.000Z");
    expect(r.to).toBe("2026-10-31T13:00:00.000Z");
  });

  it("last month = September; last 3 months = Aug → Nov", () => {
    expect(periodRange("last_month", TZ, NOW)).toMatchObject({ from: "2026-08-31T14:00:00.000Z", to: "2026-09-30T14:00:00.000Z" });
    expect(periodRange("last_3_months", TZ, NOW)).toMatchObject({ from: "2026-07-31T14:00:00.000Z", to: "2026-10-31T13:00:00.000Z" });
  });

  it("the previous period has the same length and ends where the current one starts", () => {
    expect(previousPeriodRange("this_month", TZ, NOW)).toMatchObject({ from: "2026-08-31T14:00:00.000Z", to: "2026-09-30T14:00:00.000Z" });
    expect(previousPeriodRange("last_month", TZ, NOW)).toMatchObject({ from: "2026-07-31T14:00:00.000Z", to: "2026-08-31T14:00:00.000Z" });
    expect(previousPeriodRange("last_3_months", TZ, NOW)).toMatchObject({ from: "2026-04-30T14:00:00.000Z", to: "2026-07-31T14:00:00.000Z" });
  });

  it("crosses the year boundary", () => {
    const jan = "2027-01-15T00:00:00.000Z";
    expect(periodRange("last_month", TZ, jan).from).toBe("2026-11-30T13:00:00.000Z");
    expect(previousPeriodRange("last_3_months", TZ, jan)).toMatchObject({ from: "2026-07-31T14:00:00.000Z", to: "2026-10-31T13:00:00.000Z" });
  });
});

describe("late (civil day in org tz)", () => {
  const today = "2026-10-08";
  it("due yesterday is late, due today is not, no due date is not", () => {
    expect(isLateCivil(due("2026-10-07"), today, TZ)).toBe(true);
    expect(isLateCivil(due("2026-10-08"), today, TZ)).toBe(false);
    expect(isLateCivil(due("2026-10-09"), today, TZ)).toBe(false);
    expect(isLateCivil(null, today, TZ)).toBe(false);
  });

  it("reads both deadline encodings as the intended day", () => {
    // "next day 00:00" encoding of 7 Oct = 8 Oct 00:00 AEDT = 7 Oct 13:00Z
    expect(daysFromToday("2026-10-07T13:00:00.000Z", today, TZ)).toBe(-1);
    expect(daysFromToday(due("2026-10-07"), today, TZ)).toBe(-1);
    expect(daysFromToday(due("2026-10-10"), today, TZ)).toBe(2);
    expect(daysFromToday("not a date", today, TZ)).toBeNull();
  });
});

describe("on time is measured when the EDITOR sends, not when the owner approves", () => {
  it("a slow check never makes the editor late", () => {
    const j = finished({ firstSubmittedAt: "2026-10-05T02:00:00.000Z", approvedAt: "2026-10-20T00:00:00.000Z" });
    expect(submittedOnTime(j, TZ)).toBe(true);
    expect(daysLateBySubmit(j, TZ)).toBe(0);
  });

  it("sending after the due day is late by whole civil days", () => {
    const j = finished({ firstSubmittedAt: "2026-10-06T22:30:00.000Z" }); // 7 Oct 09:30 AEDT, due 5 Oct
    expect(submittedOnTime(j, TZ)).toBe(false);
    expect(daysLateBySubmit(j, TZ)).toBe(2);
  });

  it("judges against the due date in force at approval, falling back to the current due date", () => {
    const extended = finished({ dueDate: due("2026-10-01"), dueDateAtApproval: due("2026-10-05"), firstSubmittedAt: "2026-10-04T00:00:00.000Z" });
    expect(submittedOnTime(extended, TZ)).toBe(true);
    const noSnapshot = finished({ dueDate: due("2026-10-01"), dueDateAtApproval: null, firstSubmittedAt: "2026-10-04T00:00:00.000Z" });
    expect(submittedOnTime(noSnapshot, TZ)).toBe(false);
  });

  it("is null without a due date or a send", () => {
    expect(submittedOnTime(finished({ dueDate: null, dueDateAtApproval: null }), TZ)).toBeNull();
    expect(submittedOnTime(finished({ firstSubmittedAt: null }), TZ)).toBeNull();
    expect(daysLateBySubmit(finished({ firstSubmittedAt: null }), TZ)).toBeNull();
  });
});

describe("rates + the Not-enough-jobs threshold", () => {
  const onTime = finished();
  const late = finished({ firstSubmittedAt: "2026-10-07T00:00:00.000Z" });
  const noDue = finished({ dueDate: null, dueDateAtApproval: null });

  it(`below ${MIN_JOBS_FOR_RATES} finished jobs the percentages are null and notEnough`, () => {
    const four = [onTime, onTime, late, { ...onTime, revisionCount: 2 }];
    expect(onTimeBySubmitPct(four, TZ)).toEqual({ pct: null, count: 3, measured: 4, notEnough: true });
    expect(neededChangesPct(four)).toEqual({ pct: null, count: 1, measured: 4, notEnough: true });
    expect(onTimeBySubmitPct([], TZ)).toEqual({ pct: null, count: 0, measured: 0, notEnough: true });
  });

  it("at the threshold the percentages appear; jobs without a due date are not measured", () => {
    const five = [onTime, onTime, onTime, late, noDue];
    expect(onTimeBySubmitPct(five, TZ)).toEqual({ pct: 75, count: 3, measured: 4, notEnough: false });
    expect(neededChangesPct([...five.slice(0, 3), { ...late, revisionCount: 1 }, { ...noDue, revisionCount: 3 }])).toEqual({ pct: 40, count: 2, measured: 5, notEnough: false });
  });

  it("rounds to whole percentages and treats an empty denominator as null", () => {
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33);
    // 5 finished but none measurable (no due dates) → null pct without notEnough
    expect(onTimeBySubmitPct([noDue, noDue, noDue, noDue, noDue], TZ)).toEqual({ pct: null, count: 0, measured: 0, notEnough: false });
  });

  it("deltas are current − previous, null when either side is missing", () => {
    expect(numberDelta(92, 80)).toEqual({ current: 92, previous: 80, delta: 12 });
    expect(numberDelta(null, 80)).toEqual({ current: null, previous: 80, delta: null });
    expect(numberDelta(3, null).delta).toBeNull();
  });
});

describe("average days to edit, weekly buckets, capacity", () => {
  it("averages approved − editing started in days (one decimal), skipping unmeasurable rows", () => {
    expect(
      averageDaysToEdit([
        { approvedAt: "2026-10-05T00:00:00.000Z", editingStartedAt: "2026-10-03T00:00:00.000Z" },
        { approvedAt: "2026-10-05T12:00:00.000Z", editingStartedAt: "2026-10-04T00:00:00.000Z" },
        { approvedAt: null, editingStartedAt: "2026-10-04T00:00:00.000Z" },
        { approvedAt: "2026-10-01T00:00:00.000Z", editingStartedAt: "2026-10-04T00:00:00.000Z" },
      ]),
    ).toBe(1.8);
    expect(averageDaysToEdit([])).toBeNull();
  });

  it("builds 12 Monday-start weeks ending with the current week, in org tz", () => {
    const b = weekBuckets(NOW, TZ, 1, 12);
    expect(b).toHaveLength(12);
    expect(b.at(-1)).toEqual({ weekStart: "2026-10-05", from: "2026-10-04T13:00:00.000Z", to: "2026-10-11T13:00:00.000Z" });
    expect(b[0].weekStart).toBe("2026-07-20");
    const series = finishedPerWeek(["2026-10-06T00:00:00.000Z", "2026-10-07T00:00:00.000Z", "2026-09-29T00:00:00.000Z", "2020-01-01T00:00:00.000Z"], b);
    expect(series.at(-1)).toEqual({ weekStart: "2026-10-05", finished: 2 });
    expect(series.at(-2)).toEqual({ weekStart: "2026-09-28", finished: 1 });
    expect(series.reduce((s, p) => s + p.finished, 0)).toBe(3);
  });

  it("Sunday-start weeks honour week_starts_on", () => {
    expect(weekBuckets(NOW, TZ, 0, 1)[0].weekStart).toBe("2026-10-04");
  });

  it("the desk is full only when a usual capacity is set and reached", () => {
    expect(isDeskFull(4, null)).toBe(false);
    expect(isDeskFull(4, 6)).toBe(false);
    expect(isDeskFull(6, 6)).toBe(true);
    expect(isDeskFull(0, 0)).toBe(false);
  });
});
